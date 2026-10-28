import { describe, expect, it } from "vitest";
import { newGlobalInvocationHook } from "../../global-instrumentation-hooks";
import { Transformer } from "./transformer";

describe("orchestrion transforms", () => {
  it("preserves receiver replacement for function declarations", async () => {
    const transformer = new Transformer("example", "1.0.0", "index.mjs", [
      {
        channelName: "replaceReceiver",
        module: {
          name: "example",
          versionRange: ">=1.0.0",
          filePath: "index.mjs",
        },
        functionQuery: { functionName: "request" },
      },
    ]);
    const transformed = transformer.transform(
      `export function request(input) { return this.prefix + arguments[0]; }`,
      "esm",
    ).code;
    const module = await import(
      `data:text/javascript;base64,${Buffer.from(transformed).toString("base64")}`
    );
    const remove = newGlobalInvocationHook(
      "orchestrion:example:replaceReceiver",
    ).intercept((target, _receiver, args) =>
      Reflect.apply(target, { prefix: "changed:" }, [
        String(args[0]).toUpperCase(),
      ]),
    );
    try {
      expect(module.request.call({ prefix: "original:" }, "input")).toBe(
        "changed:INPUT",
      );
    } finally {
      remove();
    }
  });

  it("forwards call arguments for function declarations", async () => {
    const transformer = new Transformer("example", "1.0.0", "index.mjs", [
      {
        channelName: "request",
        module: {
          name: "example",
          versionRange: ">=1.0.0",
          filePath: "index.mjs",
        },
        functionQuery: { functionName: "request" },
      },
    ]);
    const source = `
      export async function request(input) {
        return input;
      }
    `;
    const transformed = transformer.transform(source, "esm").code;
    const module = await import(
      `data:text/javascript;base64,${Buffer.from(transformed).toString("base64")}`
    );

    await expect(module.request("request")).resolves.toBe("request");
  });

  it("forwards call arguments for arrow-function properties", async () => {
    const transformer = new Transformer("example", "1.0.0", "index.mjs", [
      {
        channelName: "client.call",
        module: {
          name: "example",
          versionRange: ">=1.0.0",
          filePath: "index.mjs",
        },
        functionQuery: {
          propertyName: "call",
        },
      },
    ]);
    const source = `
      export class Client {
        constructor(value) {
          this.value = value;
          this.call = async (input) => ({ input, value: this.value });
        }
      }
    `;
    const transformed = transformer.transform(source, "esm").code;
    const module = await import(
      `data:text/javascript;base64,${Buffer.from(transformed).toString("base64")}`
    );

    await expect(
      new module.Client("constructor").call("request"),
    ).resolves.toEqual({
      input: "request",
      value: "constructor",
    });
  });

  describe("export aliases", () => {
    const agentConfig = (filePath: string) => ({
      channelName: "Agent.create",
      module: { name: "example", versionRange: ">=1.0.0", filePath },
      functionQuery: {
        className: "Agent",
        methodName: "create",
        isExportAlias: true,
      },
    });

    async function expectIntercepted(create: () => Promise<unknown>) {
      const remove = newGlobalInvocationHook(
        "orchestrion:example:Agent.create",
      ).intercept(async () => "intercepted");
      try {
        await expect(create()).resolves.toBe("intercepted");
      } finally {
        remove();
      }
    }

    it("resolves a minified ESM class re-exported under another name", async () => {
      const transformed = new Transformer("example", "1.0.0", "index.mjs", [
        agentConfig("index.mjs"),
      ]).transform(
        `class Fe { static async create() { return "original"; } }
         export { Fe as Agent };`,
        "esm",
      ).code;
      const module = await import(
        `data:text/javascript;base64,${Buffer.from(transformed).toString("base64")}`
      );
      await expectIntercepted(() => module.Agent.create());
    });

    it("resolves a webpack CommonJS getter export", async () => {
      const transformed = new Transformer("example", "1.0.0", "index.js", [
        agentConfig("index.js"),
      ]).transform(
        `var r = { d(target, getters) {
           for (const key in getters) Object.defineProperty(target, key, { enumerable: true, get: getters[key] });
         } };
         r.d(exports, { Agent: () => te });
         class te { static async create() { return "original"; } }`,
        "cjs",
      ).code;
      const moduleExports: Record<string, any> = {};
      new Function("exports", "require", transformed)(moduleExports, require);
      await expectIntercepted(() => moduleExports.Agent.create());
    });
  });
});
