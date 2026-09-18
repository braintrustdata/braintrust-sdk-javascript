import { describe, expect, it } from "vitest";
import { Transformer } from "./transformer";

describe("orchestrion transforms", () => {
  it("forwards call arguments for raw AST function selectors", async () => {
    const transformer = new Transformer("example", "1.0.0", "index.mjs", [
      {
        channelName: "request",
        module: {
          name: "example",
          versionRange: ">=1.0.0",
          filePath: "index.mjs",
        },
        functionQuery: { kind: "Async" },
        astQuery: 'FunctionDeclaration[id.name="request"][async]',
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
          objectName: "this",
          propertyName: "call",
          kind: "Async",
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
