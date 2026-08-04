import { create } from "@apm-js-collab/code-transformer";
import { describe, expect, it } from "vitest";
import { cloudflareThinkConfigs } from "./cloudflare-think";

describe("Cloudflare Think transformation", () => {
  it("instruments the supported inference loop without changing its result", () => {
    const matcher = create(cloudflareThinkConfigs);
    const transformer = matcher.getTransformer(
      "@cloudflare/think",
      "0.13.0",
      "dist/think.js",
    );

    try {
      expect(transformer).toBeDefined();
      const transformed = transformer!.transform(
        `
export class Think {
  async _runInferenceLoop(input) {
    return input;
  }
}
`,
        "esm",
      );
      expect(transformed.code).toContain(
        "orchestrion:@cloudflare/think:Think.runInferenceLoop",
      );
    } finally {
      transformer?.free();
      matcher.free();
    }
  });
});
