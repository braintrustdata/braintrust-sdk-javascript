import { expect, test } from "vitest";
import {
  prepareScenarioDir,
  resolveScenarioDir,
  withScenarioHarness,
} from "../../helpers/scenario-harness";
import {
  extractOtelSpans,
  summarizeRequest,
} from "../../helpers/trace-summary";

const scenarioDir = await prepareScenarioDir({
  scenarioDir: resolveScenarioDir(import.meta.url),
});

test("otel-span-processor-export sends filtered OTLP traces to Braintrust", async () => {
  await withScenarioHarness(
    async ({ requestsAfter, runScenarioDir, testRunId }) => {
      await runScenarioDir({ scenarioDir });

      const requests = requestsAfter(
        0,
        (request) => request.path === "/otel/v1/traces",
      );
      expect(requests).toHaveLength(1);

      const request = requests[0];
      const spans = extractOtelSpans(request.jsonBody);

      expect(request.headers["x-bt-parent"]).toContain(testRunId.toLowerCase());
      expect(spans.map((span) => span.name)).toContain("gen_ai.completion");
      expect(spans.map((span) => span.name)).not.toContain("root-operation");
      expect(spans[0]?.attributes["gen_ai.system"]).toBe("openai");

      expect(
        summarizeRequest(request, {
          includeHeaders: ["content-type", "x-bt-parent"],
        }),
      ).toMatchObject({
        method: "POST",
        path: "/otel/v1/traces",
      });
    },
  );
});
