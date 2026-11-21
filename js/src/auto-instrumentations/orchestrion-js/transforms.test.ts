import { describe, expect, it } from "vite-plus/test";
import { newGlobalInvocationHook } from "../../global-instrumentation-hooks";
import { Transformer } from "./transformer";

describe("orchestrion transforms", () => {
  it("hooks public constructors without changing private fields, static factories, subclassing or errors", async () => {
    const transform = new Transformer("example", "1.0.0", "index.mjs", [
      {
        channelName: "construct",
        module: { name: "example", versionRange: ">=1", filePath: "index.mjs" },
        functionQuery: { className: "Client", methodName: "constructor" },
      },
    ]);
    const source = `
      class Base {}
      export class Client extends Base {
        #value;
        constructor(options = {}) { super(); if (options.fail) throw options.fail;
          if (options.replacement) return options.replacement; this.#value = options.value; }
        get value() { return this.#value; }
        static create(options) { return new Client(options); }
      }
      export class Sub extends Client {}
    `;
    const result = transform.transform(source, "esm");
    const module = await import(
      `data:text/javascript;base64,${Buffer.from(result.code).toString("base64")}`
    );
    expect(new module.Client({ value: 1 }).value).toBe(1);
    const seen: unknown[][] = [];
    const remove = newGlobalInvocationHook(
      "orchestrion:example:construct",
    ).intercept((target, self, args) => {
      seen.push(args);
      return Reflect.apply(target, self, args);
    });
    try {
      const options = { value: 2 };
      const child = new module.Sub(options);
      expect(child.value).toBe(2);
      expect(child).toBeInstanceOf(module.Client);
      expect(child).toBeInstanceOf(module.Sub);
      expect(module.Client.name).toBe("Client");
      expect(module.Client.create(options).value).toBe(2);
      expect(new module.Client().value).toBeUndefined();
      const replacement = {};
      expect(new module.Client({ replacement })).toBe(replacement);
      const fail = new Error("construction failed");
      expect(() => new module.Client({ fail })).toThrow(fail);
      expect(seen).toHaveLength(5);
      expect(seen[0][0]).toBe(options);
    } finally {
      remove();
    }
  });

  it("finds a minified constructor through its public ESM export alias", async () => {
    const transformer = new Transformer("example", "1.0.0", "index.mjs", [
      {
        channelName: "minified",
        module: { name: "example", versionRange: ">=1", filePath: "index.mjs" },
        functionQuery: {
          className: "Client",
          methodName: "constructor",
          isExportAlias: true,
        },
      },
    ]);
    const result = transformer.transform(
      "class C{#c;constructor(o){this.#c=o.client}get client(){return this.#c}}export{C as Client}",
      "esm",
    );
    const module = await import(
      `data:text/javascript;base64,${Buffer.from(result.code).toString("base64")}`
    );
    const client = {};
    const options = { client };
    const seen: unknown[] = [];
    const remove = newGlobalInvocationHook(
      "orchestrion:example:minified",
    ).intercept((target, receiver, args) => {
      seen.push(args[0]);
      return Reflect.apply(target, receiver, args);
    });
    try {
      expect(new module.Client(options).client).toBe(client);
      expect(seen).toEqual([options]);
    } finally {
      remove();
    }
  });

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
