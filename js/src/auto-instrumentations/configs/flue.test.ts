import { create } from "@apm-js-collab/code-transformer";
import { describe, expect, it } from "vitest";
import { flueConfigs, flueVersionRange } from "./flue";

describe("flue auto-instrumentation configs", () => {
  it("targets the stable Flue 0.8 context factory", () => {
    const matcher = create(flueConfigs);
    const flue08Transformer = matcher.getTransformer(
      "@flue/runtime",
      "0.8.0",
      "dist/internal.mjs",
    );
    const flue10BetaTransformer = matcher.getTransformer(
      "@flue/runtime",
      "1.0.0-beta.3",
      "dist/internal.mjs",
    );
    const flue10Transformer = matcher.getTransformer(
      "@flue/runtime",
      "1.0.0",
      "dist/internal.mjs",
    );

    expect(flueVersionRange).toBe(">=0.8.0 <1.0.0");
    expect(flue08Transformer).toBeDefined();
    expect(flue10BetaTransformer).toBeUndefined();
    expect(flue10Transformer).toBeUndefined();
    const transformed = flue08Transformer!.transform(
      `
function createFlueContext(config) {
  return { config };
}
`,
      "esm",
    ).code;

    expect(transformed).toContain(
      "orchestrion:@flue/runtime:createFlueContext",
    );
  });

  it("does not target Flue content-hashed workflow or tool chunks", () => {
    const matcher = create(flueConfigs);

    expect(
      matcher.getTransformer(
        "@flue/runtime",
        "0.8.0",
        "dist/handle-agent-DcUclCE2.mjs",
      ),
    ).toBeUndefined();
    expect(
      matcher.getTransformer(
        "@flue/runtime",
        "0.8.0",
        "dist/sandbox-DNEJXjr_.mjs",
      ),
    ).toBeUndefined();
    expect(
      matcher.getTransformer("@flue/runtime", "1.0.0-beta.3", "dist/index.mjs"),
    ).toBeUndefined();
  });
});
