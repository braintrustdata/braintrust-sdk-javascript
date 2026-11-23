import { runInThisContext } from "node:vm";
import { beforeAll, beforeEach, afterEach, expect, it } from "vite-plus/test";
import { InstrumentationMatcher } from "../../src/auto-instrumentations/orchestrion-js";
import { falConfigs } from "../../src/auto-instrumentations/configs/fal";
import { initLogger } from "../../src/logger/core";
import { _exportsForTestingOnly } from "../../src/logger/testing";
import { registerInstrumentation } from "../../src/instrumentation/registrations/fal";
import { configureNode } from "../../src/node/config";
import { wrapFal } from "../../src/wrappers/fal";

configureNode();
registerInstrumentation();
let logger: ReturnType<typeof _exportsForTestingOnly.useTestBackgroundLogger>;
beforeAll(async () => {
  await _exportsForTestingOnly.simulateLoginForTests();
});
beforeEach(() => {
  logger = _exportsForTestingOnly.useTestBackgroundLogger();
  initLogger({ projectName: "tmp-luca", projectId: "test-project-id" });
});
afterEach(() => {
  _exportsForTestingOnly.clearTestBackgroundLogger();
});

it.each(["1.10.0", "1.11.0"])(
  "wraps public factory results on %s and keeps raw APIs untouched",
  async (version) => {
    // Exercise the public factory transformation, including closure-backed methods
    // and the singleton's delegation, without copying provider implementation code.
    const source = `
    function createFalClient(config) {
      const queue = { submit: async () => ({ requestId: "request" }), result: async () => ({ data: { images: [] }, requestId: "request" }) };
      return { queue, storage: {}, realtime: {}, streaming: { stream() {} }, stream() {},
        run: async () => ({ data: { images: [] }, requestId: "direct" }),
        subscribe: async () => { await queue.submit(); return queue.result(); }
      };
    }
    exports.createFalClient = createFalClient;
    const client = createFalClient();
    exports.fal = {
      get streaming() { return client.streaming; },
      get queue() { return client.queue; },
      run: (...args) => client.run(...args),
      subscribe: (...args) => client.subscribe(...args),
      stream: (...args) => client.stream(...args)
    };
  `;
    const transformer = new InstrumentationMatcher(falConfigs).getTransformer(
      "@fal-ai/client",
      version,
      "src/client.js",
    )!;
    const instrumented = transformer.transform(source, "cjs");
    const module = { exports: {} as Record<string, any> };
    runInThisContext(`(function(exports) { ${instrumented.code} })`)(
      module.exports,
    );
    const singleton = wrapFal(module.exports.fal);
    const custom = module.exports.createFalClient();
    await singleton.subscribe("fal-ai/image", { input: { prompt: "bird" } });
    await custom.queue.submit();
    await custom.queue.result();
    await custom.subscribe("fal-ai/image", { input: { prompt: "bird" } });
    expect(await logger.drain()).toEqual([]);
    await singleton.run("fal-ai/image", { input: { prompt: "bird" } });
    await custom.run("fal-ai/audio", { input: { prompt: "hello" } });
    const rows = (await logger.drain()) as Record<string, any>[];
    expect(
      rows
        .filter((row) => row.span_attributes?.name)
        .map((row) => row.span_attributes.name),
    ).toEqual(["fal.run", "fal.run"]);
    expect(rows.filter((row) => row.metrics?.end)).toHaveLength(2);
  },
);
