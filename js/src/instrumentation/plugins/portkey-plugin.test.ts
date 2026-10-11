import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Portkey } from "portkey-ai";
import { _exportsForTestingOnly, initLogger, traced } from "../../logger";
import { configureNode } from "../../node/config";
import { create } from "../../auto-instrumentations/orchestrion-js";
import { getDefaultInstrumentationConfigs } from "../../auto-instrumentations/configs/all";
import { readDisabledInstrumentationEnvConfig } from "../config";
import { wrapPortkey } from "../../wrappers/portkey";

configureNode();

const require = createRequire(import.meta.url);
const filename = require.resolve("portkey-ai/dist/src/apis/chatCompletions.js");
const source = readFileSync(filename, "utf8");
const { version } = require("portkey-ai/package.json") as { version: string };
const request = {
  model: "test-model",
  messages: [{ role: "user" as const, content: "Say hello" }],
  max_tokens: 16,
};
const usage = { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 };
const completion = {
  id: "test-completion",
  object: "chat.completion",
  model: "test-model",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "Hello!" },
      finish_reason: "stop",
    },
  ],
  usage,
};

// Execute the installed SDK's actual resource through the same transformer used
// by the loader/bundlers. Only HTTP is stubbed: these are hermetic unit tests,
// not provider recordings.
function autoClient(disabledList?: string) {
  const client = new Portkey({
    apiKey: "test-key",
    baseURL: "https://portkey.test/v1",
  });
  const transformer = create(
    getDefaultInstrumentationConfigs({
      disabledIntegrationConfig:
        readDisabledInstrumentationEnvConfig(disabledList).integrations,
    }),
  ).getTransformer("portkey-ai", version, "dist/src/apis/chatCompletions.js");
  const code = transformer?.transform(source, "cjs").code ?? source;
  const exports: { Chat?: new (client: Portkey) => Portkey["chat"] } = {};
  runInNewContext(code, {
    exports,
    require: createRequire(filename),
    globalThis,
    Map,
  });
  client.chat = new exports.Chat!(client);
  return client;
}

describe("Portkey instrumentation", () => {
  let backgroundLogger: ReturnType<
    typeof _exportsForTestingOnly.useTestBackgroundLogger
  >;
  const fetchMock = vi.fn<typeof fetch>();

  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
  });
  beforeEach(() => {
    backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({
      projectName: "portkey-plugin.test.ts",
      projectId: "test-project-id",
    });
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => Response.json(completion));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    _exportsForTestingOnly.clearTestBackgroundLogger();
  });

  for (const mode of ["wrapped", "auto", "wrapped-auto"] as const) {
    describe(mode, () => {
      function makeClient() {
        const client =
          mode === "wrapped"
            ? new Portkey({
                apiKey: "test-key",
                baseURL: "https://portkey.test/v1",
              })
            : autoClient();
        return mode === "auto" ? client : wrapPortkey(client);
      }

      it("records one child span with input, output, usage and Portkey provenance", async () => {
        const client = makeClient();
        await traced(
          async () => {
            const response = await client.chat.completions.create(request);
            expect(response.choices).toEqual(completion.choices);
            expect(typeof response.getHeaders).toBe("function");
          },
          { name: "parent" },
        );
        const spans = await backgroundLogger.drain();
        const calls = spans.filter(
          (span) =>
            "span_attributes" in span &&
            span.span_attributes?.name === "portkey.chat.completions.create",
        );
        expect(calls).toHaveLength(1);
        const parent = spans.find(
          (span) =>
            "span_attributes" in span &&
            span.span_attributes?.name === "parent",
        );
        expect(calls[0]).toMatchObject({
          input: request.messages,
          output: completion.choices,
          metadata: {
            provider: "portkey",
            model: request.model,
            max_tokens: 16,
          },
          metrics: { prompt_tokens: 8, completion_tokens: 2, tokens: 10 },
          span_parents: [
            parent && "span_id" in parent ? parent.span_id : undefined,
          ],
          span_attributes: { type: "llm" },
          context: { span_origin: { instrumentation: { name: "portkey" } } },
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });

      it("forwards gateway configuration and request options without logging credentials", async () => {
        await makeClient().chat.completions.create(
          request,
          {
            apiKey: "private-gateway-key",
            virtualKey: "private-provider-key",
            provider: "openai",
          },
          { extraHeaders: { "x-test-request": "forwarded" } },
        );
        const [url, options] = fetchMock.mock.calls[0];
        expect(String(url)).toBe("https://portkey.test/v1/chat/completions");
        expect(new Headers(options?.headers).get("x-test-request")).toBe(
          "forwarded",
        );
        const spans = await backgroundLogger.drain();
        expect(spans).toHaveLength(1);
        expect(JSON.stringify(spans)).not.toContain("private-gateway-key");
        expect(JSON.stringify(spans)).not.toContain("private-provider-key");
      });

      it("aggregates streaming text, tool arguments and final usage without consuming chunks", async () => {
        const chunks = [
          {
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  content: "Hello",
                  tool_calls: [
                    {
                      index: 0,
                      id: "call-1",
                      type: "function",
                      function: { name: "weather", arguments: '{"city":' },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                index: 0,
                delta: {
                  content: "!",
                  tool_calls: [
                    { index: 0, function: { arguments: '"Paris"}' } },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          },
          { choices: [], usage },
        ];
        fetchMock.mockImplementation(
          async () =>
            new Response(
              chunks
                .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
                .join("") + "data: [DONE]\n\n",
              { headers: { "content-type": "text/event-stream" } },
            ),
        );
        const stream = await makeClient().chat.completions.create({
          ...request,
          stream: true,
        });
        const received = [];
        for await (const chunk of stream) received.push(chunk);
        expect(received).toEqual(chunks);
        const spans = await backgroundLogger.drain();
        expect(spans).toHaveLength(1);
        expect(spans[0]).toMatchObject({
          output: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "Hello!",
                tool_calls: [
                  {
                    id: "call-1",
                    type: "function",
                    function: {
                      name: "weather",
                      arguments: '{"city":"Paris"}',
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          metrics: {
            prompt_tokens: 8,
            completion_tokens: 2,
            tokens: 10,
            time_to_first_token: expect.any(Number),
          },
        });
      });

      it("preserves SDK errors and finishes the error span", async () => {
        fetchMock.mockImplementation(async () =>
          Response.json(
            { error: { message: "invalid model" } },
            { status: 400 },
          ),
        );
        await expect(
          makeClient().chat.completions.create(request),
        ).rejects.toThrow("invalid model");
        const spans = await backgroundLogger.drain();
        expect(spans).toHaveLength(1);
        expect(spans[0]).toMatchObject({
          error: expect.stringContaining("invalid model"),
          metrics: { end: expect.any(Number) },
        });
      });

      it("finishes a partially consumed stream", async () => {
        fetchMock.mockImplementation(
          async () =>
            new Response(
              'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"}}]}\n\ndata: [DONE]\n\n',
              { headers: { "content-type": "text/event-stream" } },
            ),
        );
        const stream = await makeClient().chat.completions.create({
          ...request,
          stream: true,
        });
        for await (const chunk of stream) {
          expect(chunk.choices).toHaveLength(1);
          break;
        }
        const spans = await backgroundLogger.drain();
        expect(spans).toHaveLength(1);
        expect(spans[0]).toMatchObject({
          metrics: { end: expect.any(Number) },
        });
      });

      it("propagates stream errors and closes the span", async () => {
        fetchMock.mockImplementation(
          async () =>
            new Response(
              'event: error\ndata: {"message":"stream failed"}\n\n',
              { headers: { "content-type": "text/event-stream" } },
            ),
        );
        const stream = await makeClient().chat.completions.create({
          ...request,
          stream: true,
        });
        await expect(async () => {
          for await (const chunk of stream) void chunk;
        }).rejects.toThrow("stream failed");
        const spans = await backgroundLogger.drain();
        expect(spans).toHaveLength(1);
        expect(spans[0]).toMatchObject({
          error: expect.stringContaining("stream failed"),
          metrics: { end: expect.any(Number) },
        });
      });
    });
  }

  it.each(["portkey", "portkey-ai"])(
    "honors the %s disable alias",
    async (alias) => {
      const response = await autoClient(alias).chat.completions.create(request);
      expect(response.choices).toEqual(completion.choices);
      expect(await backgroundLogger.drain()).toEqual([]);
    },
  );

  it("keeps wrapping idempotent and preserves the client API", async () => {
    const original = new Portkey({ apiKey: "test-key" });
    const client = wrapPortkey(original);
    expect(wrapPortkey(original)).toBe(client);
    expect(wrapPortkey(client)).toBe(client);
    expect(client).toBeInstanceOf(Portkey);
    expect(client.chat.completions.create).toBe(client.chat.completions.create);
    expect(client.models).toBe(original.models);
    await client.chat.completions.create(request);
    expect(await backgroundLogger.drain()).toHaveLength(1);
  });
});
