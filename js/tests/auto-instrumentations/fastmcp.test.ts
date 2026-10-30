import { describe, expect, it } from "vitest";
import { InstrumentationMatcher } from "../../src/auto-instrumentations/orchestrion-js";
import { fastMCPConfigs } from "../../src/auto-instrumentations/configs/fastmcp";
import { fastMCPChannels } from "../../src/instrumentation/plugins/fastmcp-interceptors";

describe("FastMCP session transformation", () => {
  it.each(["3.35.0", "4.0.0", "4.23.7"])(
    "invokes the session hook for %s CJS and ESM chunks",
    async (version) => {
      for (const extension of ["js", "cjs"]) {
        const transformer = new InstrumentationMatcher(
          fastMCPConfigs,
        ).getTransformer("fastmcp", version, `dist/chunk-ABC123.${extension}`)!;
        const source = `
        var FastMCPSession = class {
          #server = { connect(transport) { return transport; } };
          get server() { return this.#server; }
          async connect(transport) { return this.#server.connect(transport); }
        };
        globalThis.testSession = new FastMCPSession();
      `;
        const result = transformer.transform(
          source,
          extension === "js" ? "esm" : "cjs",
        );
        const calls: unknown[] = [];
        const remove = fastMCPChannels.sessionConnect.intercept(
          (target, receiver, args) => {
            calls.push(receiver);
            return Reflect.apply(target, receiver, args);
          },
        );
        try {
          const scope = globalThis as typeof globalThis & {
            testSession?: { connect(value: unknown): Promise<unknown> };
          };
          Function(result.code)();
          const session = scope.testSession!;
          const transport = { start() {}, send() {} };
          expect(await session.connect(transport)).toBe(transport);
          expect(calls).toEqual([session]);
          delete scope.testSession;
        } finally {
          remove();
        }
      }
    },
  );
});
