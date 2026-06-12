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

type OtlpTraceRequest = {
  resourceSpans?: Array<{
    scopeSpans?: Array<{
      scope?: {
        name?: string;
        version?: string;
      };
      spans?: Array<{
        name?: string;
        parentSpanId?: string;
      }>;
    }>;
  }>;
};

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

test("otel-span-processor-export exports OTel 1.x-shaped spans through the OTLP path", async () => {
  await withScenarioHarness(
    async ({ requestsAfter, runScenarioDir, testRunId }) => {
      await runScenarioDir({
        entry: "scenario.otel-v1-shape.ts",
        scenarioDir,
      });

      const requests = requestsAfter(
        0,
        (request) => request.path === "/otel/v1/traces",
      );
      expect(requests).toHaveLength(1);

      const request = requests[0];
      const spans = extractOtelSpans(request.jsonBody);
      const compatSpan = spans.find(
        (span) => span.name === "gen_ai.otel-v1-compat",
      );
      const body = request.jsonBody as OtlpTraceRequest;
      const scopeSpan = body.resourceSpans
        ?.flatMap((resourceSpan) => resourceSpan.scopeSpans ?? [])
        .find((candidate) =>
          candidate.spans?.some(
            (span) => span.name === "gen_ai.otel-v1-compat",
          ),
        );

      expect(request.headers["x-bt-parent"]).toContain(testRunId.toLowerCase());
      expect(scopeSpan?.scope).toEqual({
        name: "otel-v1-e2e-lib",
        version: "1.2.3",
      });
      expect(compatSpan?.parentSpanId).toBe("3333333333333333");
      expect(compatSpan?.attributes.testRunId).toBe(testRunId);
    },
  );
});
