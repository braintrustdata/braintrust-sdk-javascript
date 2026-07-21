import { create } from "@apm-js-collab/code-transformer";
import { describe, expect, it } from "vitest";
import { cloudflareAIChatConfigs } from "./cloudflare-ai-chat";

describe("cloudflareAIChatConfigs", () => {
  it.each(["0.9.0", "0.9.3"])(
    "transforms the AIChatAgent turn runner in %s",
    (version) => {
      const matcher = create(cloudflareAIChatConfigs);
      const transformer = matcher.getTransformer(
        "@cloudflare/ai-chat",
        version,
        "dist/index.js",
      );

      try {
        expect(transformer).toBeDefined();
        const transformed = transformer!.transform(
          `
var AIChatAgent = class AIChatAgent extends Agent {
  static {
    this.marker = "class-static-block";
  }
  async _runExclusiveChatTurn(requestId, fn, options) {
    return await fn();
  }
};
export { AIChatAgent };
`,
          "esm",
        );
        expect(transformed.code).toContain(
          "orchestrion:@cloudflare/ai-chat:AIChatAgent._runExclusiveChatTurn",
        );
      } finally {
        transformer?.free();
        matcher.free();
      }
    },
  );
});
