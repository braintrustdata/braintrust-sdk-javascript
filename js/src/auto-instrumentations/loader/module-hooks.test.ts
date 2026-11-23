import { afterEach, beforeEach, expect, it } from "vite-plus/test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  initialize,
  load,
  loadSync,
  syncTransformedSources,
} from "./module-hooks.mjs";
import { OPENAI_API_PROMISE_PATCH } from "./openai-api-promise-patch";

let dir: string;
let packageDir: string;
const source = "class Client { create(input) { return input; } }";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "braintrust-module-hooks-"));
  // Use an alias to ensure matching uses the package's declared identity.
  packageDir = join(dir, "node_modules", "openai-alias");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    join(packageDir, "package.json"),
    JSON.stringify({ name: "openai", version: "6.0.0" }),
  );
  initialize({
    instrumentations: [
      {
        channelName: "test:client:create",
        module: {
          name: "openai",
          versionRange: "^6.0.0",
          filePath: "client.js",
        },
        functionQuery: { className: "Client", methodName: "create" },
      },
    ],
  });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

it("instruments modules during load without a preceding resolve hook", async () => {
  const url = pathToFileURL(join(packageDir, "client.js")).href;
  const result = await load(url, {}, async () => ({
    format: "module",
    source,
  }));

  expect(result.source).toContain("test:client:create");
  expect(result.shortCircuit).toBe(true);
});

it.each([
  ["string", source],
  ["Buffer", Buffer.from(source)],
  ["Uint8Array", new TextEncoder().encode(source)],
  ["ArrayBuffer", new TextEncoder().encode(source).buffer],
  ["Uint8Array slice", new TextEncoder().encode(`!${source}!`).subarray(1, -1)],
])("decodes %s source before transforming", async (_name, bytes) => {
  const url = pathToFileURL(join(packageDir, "client.js")).href;
  const result = await load(url, {}, async () => ({
    format: "module",
    source: bytes,
  }));

  expect(result.source).toContain("class Client");
  expect(result.source).toContain("test:client:create");
});

it.each([["commonjs"], [undefined]])(
  "instruments CommonJS directly with synchronous hooks (format: %s)",
  (format) => {
    const filePath = join(packageDir, "client.js");
    const result = loadSync(pathToFileURL(filePath).href, {}, () => ({
      format,
      source,
    }));

    expect(result.source).toContain("test:client:create");
    expect(result.shortCircuit).toBe(true);
    // Lets the Module._compile patch skip the already transformed file.
    expect(syncTransformedSources.get(filePath)).toBe(result.source);
  },
);

it.each([
  ["async", load],
  ["sync", loadSync],
])(
  "leaves import-in-the-middle wrapper modules alone (%s)",
  async (_name, loadHook) => {
    const url = `${pathToFileURL(join(packageDir, "client.js")).href}?iitm=true`;
    // Use a transformable source so only the URL check can skip it.
    const original = { format: "module", source };
    const result = await loadHook(url, {}, () => original);

    expect(result).toBe(original);
    expect(result.shortCircuit).toBeUndefined();
  },
);

it.each([
  ["async", load],
  ["sync", loadSync],
])(
  "reads omitted CommonJS source for an instrumentation target (%s)",
  async (_name, loadHook) => {
    writeFileSync(join(packageDir, "client.js"), source);
    const url = pathToFileURL(join(packageDir, "client.js")).href;
    const result = await loadHook(url, {}, () => ({
      format: "commonjs",
      source: null,
    }));

    expect(result.source).toContain("test:client:create");
    expect(result.shortCircuit).toBe(true);
  },
);

it.each([
  ["async", load],
  ["sync", loadSync],
])(
  "reads redirected CommonJS source when another loader omits it (%s)",
  async (_name, loadHook) => {
    writeFileSync(join(packageDir, "client.js"), source);
    const redirectedPath = join(packageDir, "redirected.js");
    writeFileSync(
      redirectedPath,
      "class Client { create(input) { return 'redirected'; } }",
    );
    const result = await loadHook(
      pathToFileURL(join(packageDir, "client.js")).href,
      {},
      () => ({
        format: "commonjs",
        source: null,
        responseURL: pathToFileURL(redirectedPath).href,
      }),
    );

    expect(
      new Function(
        `${result.source}; return new Client().create('original');`,
      )(),
    ).toBe("redirected");
  },
);

it.each([
  ["async", load],
  ["sync", loadSync],
])(
  "leaves omitted CommonJS source alone for unrelated files (%s)",
  async (_name, loadHook) => {
    // This file does not exist: attempting to read it would fail.
    const url = pathToFileURL(join(packageDir, "unrelated.js")).href;
    const original = { format: "commonjs", source: null };
    const result = await loadHook(url, {}, () => original);

    expect(result).toBe(original);
    expect(result.source).toBeNull();
    expect(result.shortCircuit).toBeUndefined();
  },
);

it("applies special-case patches without a matching instrumentation config", async () => {
  initialize({ instrumentations: [] });
  const url = pathToFileURL(join(packageDir, "api-promise.mjs")).href;
  const source = "export class APIPromise extends Promise {}";
  const result = await load(url, {}, async () => ({
    format: "module",
    source,
  }));

  expect(result.source).toBe(source + OPENAI_API_PROMISE_PATCH);
  expect(result.shortCircuit).toBe(true);
});
