import { describe, expect, it } from "vite-plus/test";
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
});
