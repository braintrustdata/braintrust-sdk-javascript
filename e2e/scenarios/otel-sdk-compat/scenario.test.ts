import { promises as fs } from "node:fs";
import path from "node:path";
import { expect, test } from "vite-plus/test";
import {
  prepareScenarioDir,
  resolveScenarioDir,
  withScenarioHarness,
} from "../../helpers/scenario-harness";
import { extractOtelSpans } from "../../helpers/trace-summary";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const variants = [
  "otel-v1",
  "otel-v1-latest",
  "otel-v2",
  "otel-v2-latest",
  "otel-v3",
  "otel-v3-latest",
];
const prepared = await Promise.all(
  variants.map(async (variant) => {
    // Separate install roots prevent different OTel API peer ranges from sharing a copy.
    const sourceDir = path.resolve(
      originalScenarioDir,
      `../../.bt-tmp/generated-scenarios/otel-sdk-compat-${variant}`,
    );
    await fs.rm(sourceDir, { recursive: true, force: true });
    await fs.cp(path.join(originalScenarioDir, "template"), sourceDir, {
      recursive: true,
    });
    await fs.cp(
      path.join(originalScenarioDir, "versions", variant),
      sourceDir,
      { recursive: true },
    );
    return {
      variant,
      scenarioDir: await prepareScenarioDir({ scenarioDir: sourceDir }),
    };
  }),
);

for (const { variant, scenarioDir } of prepared) {
  test(`otel-sdk-compat ${variant}: native context, filtering, customization and OTLP export`, async () => {
    await withScenarioHarness(
      async ({ runNodeScenarioDir, requestsAfter, testRunId }) => {
        await runNodeScenarioDir({
          scenarioDir,
          entry: "scenario.mjs",
          env: { OTEL_MAJOR: variant.slice(6, 7) },
          runContext: {
            variantKey: variant,
            originalScenarioDir,
            cassette: false,
          },
        });
        const requests = requestsAfter(
          0,
          (request) => request.path === "/otel/v1/traces",
        );
        expect(requests).toHaveLength(1);
        const spans = extractOtelSpans(requests[0].jsonBody);
        expect(spans.map((span) => span.name).sort()).toEqual([
          "gen_ai.child",
          "gen_ai.remote",
        ]);
        for (const span of spans) {
          expect(span.attributes.testRunId).toBe(testRunId);
          expect(span.attributes.reviewed).toBe(true);
          expect(span.attributes.secret).toBeUndefined();
          expect(span.attributes["braintrust.parent"]).toBeDefined();
          expect(span.parentSpanId).toBeDefined();
        }
        expect(spans[0].traceId).toBe(spans[1].traceId);
        expect(spans[0].parentSpanId).toBe(spans[1].parentSpanId);
        expect(JSON.stringify(requests[0].jsonBody)).not.toContain(
          "private-payload",
        );
      },
    );
  });
}
