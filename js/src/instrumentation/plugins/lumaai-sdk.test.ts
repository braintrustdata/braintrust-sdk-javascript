import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import LumaAI from "lumaai";
import { InstrumentationMatcher } from "../../auto-instrumentations/orchestrion-js";
import { getDefaultInstrumentationConfigs } from "../../auto-instrumentations/configs/all";
import { _exportsForTestingOnly, initLogger } from "../../logger";
import { configureNode } from "../../node/config";
import { readDisabledInstrumentationEnvConfig } from "../config";

configureNode();
const require = createRequire(import.meta.url);

// Focused SDK integration tests with synthetic HTTP responses. These are not
// provider recordings and do not substitute for real-provider e2e coverage.
async function clientFor(format: "cjs" | "esm", disabled = false) {
  const extension = format === "cjs" ? "js" : "mjs";
  const file = `resources/generations/generations.${extension}`;
  const filename = require.resolve(`lumaai/${file}`);
  const { version } = JSON.parse(
    readFileSync(
      join(dirname(require.resolve("lumaai")), "package.json"),
      "utf8",
    ),
  );
  const matcher = new InstrumentationMatcher(
    getDefaultInstrumentationConfigs({
      disabledIntegrationConfig: readDisabledInstrumentationEnvConfig(
        disabled ? "lumaai" : undefined,
      ).integrations,
    }),
  );
  const source = readFileSync(filename, "utf8");
  const code =
    matcher.getTransformer("lumaai", version, file)?.transform(source, format)
      .code ?? source;
  let Generations: new (client: LumaAI) => LumaAI["generations"];
  if (format === "cjs") {
    const mod = {
      exports: {} as {
        Generations: new (client: LumaAI) => LumaAI["generations"];
      },
    };
    new Function("require", "exports", "module", code)(
      createRequire(filename),
      mod.exports,
      mod,
    );
    Generations = mod.exports.Generations;
  } else {
    const resolved = code.replace(
      /from\s+(["'])(\.[^"']+)\1/g,
      (_match, quote, specifier) =>
        `from ${quote}${new URL(specifier, pathToFileURL(filename)).href}${quote}`,
    );
    ({ Generations } = await import(
      `data:text/javascript;base64,${Buffer.from(resolved).toString("base64")}`
    ));
  }
  const fetch = vi.fn(async (_url: unknown, options: any) => {
    const output =
      options.method === "POST"
        ? { id: "generation-1", state: "queued", model: "ray-2" }
        : {
            id: "generation-1",
            state: "completed",
            assets: { video: "https://example.com/video.mp4" },
          };
    return new Response(JSON.stringify(output), {
      headers: { "content-type": "application/json" },
    });
  });
  const client = new LumaAI({
    authToken: "unit-test-token",
    maxRetries: 0,
    fetch: fetch as any,
  });
  client.generations = new Generations(client);
  return { client, fetch };
}

describe("published Luma SDK instrumentation", () => {
  let backgroundLogger: ReturnType<
    typeof _exportsForTestingOnly.useTestBackgroundLogger
  >;
  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
  });
  beforeEach(() => {
    backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({
      projectName: "lumaai-sdk.test.ts",
      projectId: "test-project-id",
    });
  });
  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
  });

  it.each(["cjs", "esm"] as const)(
    "traces actual %s create/get calls and preserves APIPromise helpers",
    async (format) => {
      const { client, fetch } = await clientFor(format);
      const body = {
        model: "ray-2" as const,
        prompt: "A calm lake",
        duration: "5s",
        resolution: "540p",
      };
      const pending = client.generations.create(body);
      expect(typeof pending.asResponse).toBe("function");
      const { data, response } = await pending.withResponse();
      expect(response.status).toBe(200);
      expect(data.id).toBe("generation-1");
      const polled = await client.generations.get(data.id!);
      expect(polled.assets?.video).toBe("https://example.com/video.mp4");
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(body);
      const spans = await backgroundLogger.drain();
      expect(spans).toHaveLength(2);
      expect(spans[0]).toMatchObject({
        span_attributes: { name: "lumaai.generations.create" },
        input: { prompt: body.prompt },
        output: { id: data.id, state: "queued" },
      });
      expect(spans[1]).toMatchObject({
        span_attributes: { name: "lumaai.generations.get" },
        input: { id: data.id },
        output: polled,
      });
      expect(JSON.stringify(spans)).not.toContain("unit-test-token");
    },
  );

  it("honors the environment opt-out without changing SDK requests", async () => {
    const { client, fetch } = await clientFor("cjs", true);
    await client.generations.create({ model: "ray-2", prompt: "A calm lake" });
    await client.generations.get("generation-1");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await backgroundLogger.drain()).toHaveLength(0);
  });

  it.each(["cjs", "esm"] as const)(
    "preserves the unread asResponse body in %s",
    async (format) => {
      const { client } = await clientFor(format);
      const response = await client.generations
        .create({ model: "ray-2", prompt: "A calm lake" })
        .asResponse();
      expect(response.bodyUsed).toBe(false);
      await expect(response.json()).resolves.toMatchObject({
        id: "generation-1",
      });
      expect(await backgroundLogger.drain()).toMatchObject([
        { output: { id: "generation-1", state: "queued" } },
      ]);
    },
  );

  it("preserves provider HTTP errors and closes the span", async () => {
    const { client, fetch } = await clientFor("cjs");
    fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(
      client.generations.get("generation-1").asResponse(),
    ).rejects.toMatchObject({ status: 429 });
    expect(await backgroundLogger.drain()).toMatchObject([
      {
        error: expect.stringContaining("429"),
        metrics: { end: expect.any(Number) },
      },
    ]);
  });
});
