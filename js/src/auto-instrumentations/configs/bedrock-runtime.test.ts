import { create, type ModuleType } from "@apm-js-collab/code-transformer";
import { describe, expect, it } from "vitest";
import { bedrockRuntimeConfigs } from "./bedrock-runtime";

const CJS_CLIENT_SOURCE = `
class Client {
  send(command, optionsOrCb, cb) {
    if (typeof optionsOrCb === "function" || typeof cb === "function") {
      return undefined;
    }
    return Promise.resolve(command);
  }
}
module.exports = { Client };
`;

const ESM_CLIENT_SOURCE = `
export class Client {
  send(command, optionsOrCb, cb) {
    if (typeof optionsOrCb === "function" || typeof cb === "function") {
      return undefined;
    }
    return Promise.resolve(command);
  }
}
`;

describe("bedrockRuntimeConfigs", () => {
  it("matches current and legacy Smithy Client.send entry files", () => {
    const matcher = create(bedrockRuntimeConfigs);

    try {
      for (const entry of [
        {
          channelName: "orchestrion:@smithy/core:client.send",
          moduleName: "@smithy/core",
          moduleType: "cjs" as ModuleType,
          path: "dist-cjs/submodules/client/index.js",
          source: CJS_CLIENT_SOURCE,
          version: "3.25.1",
        },
        {
          channelName: "orchestrion:@smithy/core:client.send",
          moduleName: "@smithy/core",
          moduleType: "esm" as ModuleType,
          path: "dist-es/submodules/client/smithy-client/client.js",
          source: ESM_CLIENT_SOURCE,
          version: "3.25.1",
        },
        {
          channelName: "orchestrion:@smithy/smithy-client:client.send",
          moduleName: "@smithy/smithy-client",
          moduleType: "cjs" as ModuleType,
          path: "dist-cjs/index.js",
          source: CJS_CLIENT_SOURCE,
          version: "3.0.0",
        },
        {
          channelName: "orchestrion:@smithy/smithy-client:client.send",
          moduleName: "@smithy/smithy-client",
          moduleType: "esm" as ModuleType,
          path: "dist-es/client.js",
          source: ESM_CLIENT_SOURCE,
          version: "3.0.0",
        },
        {
          channelName: "orchestrion:@smithy/smithy-client:client.send",
          moduleName: "@smithy/smithy-client",
          moduleType: "cjs" as ModuleType,
          path: "dist-cjs/index.js",
          source: CJS_CLIENT_SOURCE,
          version: "4.8.0",
        },
        {
          channelName: "orchestrion:@smithy/smithy-client:client.send",
          moduleName: "@smithy/smithy-client",
          moduleType: "esm" as ModuleType,
          path: "dist-es/client.js",
          source: ESM_CLIENT_SOURCE,
          version: "4.8.0",
        },
      ]) {
        const transformer = matcher.getTransformer(
          entry.moduleName,
          entry.version,
          entry.path,
        );

        try {
          expect(transformer).toBeDefined();
          const transformed = transformer!.transform(
            entry.source,
            entry.moduleType,
          );
          expect(transformed.code).toContain(entry.channelName);
        } finally {
          transformer?.free();
        }
      }
    } finally {
      matcher.free();
    }
  });
});
