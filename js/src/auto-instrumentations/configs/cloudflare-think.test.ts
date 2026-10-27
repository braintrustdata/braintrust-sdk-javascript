import { InstrumentationMatcher } from "../orchestrion-js";
import { describe, expect, it } from "vite-plus/test";
import { cloudflareThinkConfigs } from "./cloudflare-think";

describe("Cloudflare Think transformation", () => {
  it("instruments the supported inference loop without changing its result", () => {
    const matcher = new InstrumentationMatcher(cloudflareThinkConfigs);
    const transformer = matcher.getTransformer(
      "@cloudflare/think",
      "0.13.0",
      "dist/think.js",
    );

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
  });
});
