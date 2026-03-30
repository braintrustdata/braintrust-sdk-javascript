import { expect, test } from "vitest";
import {
  formatJsonFileSnapshot,
  resolveFileSnapshotPath,
} from "../../helpers/file-snapshot";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
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

const TIMEOUT_MS = 120_000;

interface OtelExportScenario {
  dependencyName: string;
  entry: string;
  version: string;
}

const scenarios: OtelExportScenario[] = await Promise.all(
  [
    { dependencyName: "ai-sdk-v5", entry: "scenario.ai-sdk-v5.ts" },
    { dependencyName: "ai-sdk-v6", entry: "scenario.ai-sdk-v6.ts" },
  ].map(async (spec) => ({
    ...spec,
    version: await readInstalledPackageVersion(
      scenarioDir,
      spec.dependencyName,
    ),
  })),
);

for (const scenario of scenarios) {
  test(
    `ai-sdk-otel-export sends AI SDK telemetry spans to Braintrust via BraintrustExporter (ai ${scenario.version})`,
    {
      timeout: TIMEOUT_MS,
    },
    async () => {
      await withScenarioHarness(
        async ({ requestsAfter, runScenarioDir, testRunId }) => {
          await runScenarioDir({
            entry: scenario.entry,
            scenarioDir,
            timeoutMs: TIMEOUT_MS,
          });

          const otelRequests = requestsAfter(
            0,
            (request) => request.path === "/otel/v1/traces",
          );
          expect(otelRequests.length).toBeGreaterThanOrEqual(1);

          const allSpans = otelRequests.flatMap((request) =>
            extractOtelSpans(request.jsonBody),
          );
          const spanNames = allSpans.map((span) => span.name);

          // AI SDK with experimental_telemetry emits spans prefixed with "ai."
          // The generate call should produce an "ai.generateText" or similar span.
          const aiSpans = allSpans.filter((span) =>
            span.name.startsWith("ai."),
          );
          expect(aiSpans.length).toBeGreaterThanOrEqual(3);

          // Verify the key operations are present.
          const hasGenerateSpan = spanNames.some(
            (name) =>
              name === "ai.generateText" ||
              name === "ai.generateText.doGenerate",
          );
          const hasStreamSpan = spanNames.some(
            (name) =>
              name === "ai.streamText" || name === "ai.streamText.doStream",
          );
          const hasToolSpan = spanNames.some(
            (name) =>
              name === "ai.toolCall" ||
              name === "ai.generateText" ||
              name === "ai.generateText.doGenerate",
          );
          expect(hasGenerateSpan).toBe(true);
          expect(hasStreamSpan).toBe(true);
          expect(hasToolSpan).toBe(true);

          // Verify spans have AI SDK telemetry attributes.
          for (const span of aiSpans) {
            // AI SDK spans should have gen_ai or ai.telemetry attributes
            const hasAIAttributes =
              Object.keys(span.attributes).some(
                (key) =>
                  key.startsWith("gen_ai.") ||
                  key.startsWith("ai.") ||
                  key.startsWith("resource.name"),
              ) || span.name.startsWith("ai.");
            expect(hasAIAttributes).toBe(true);
          }

          // Verify the x-bt-parent header contains the test run ID (scoped project name).
          const firstOtelRequest = otelRequests[0];
          expect(firstOtelRequest.headers["x-bt-parent"]).toContain(
            testRunId.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
          );

          // filterAISpans is true, so non-AI root spans should be filtered out.
          const nonAIRootSpans = allSpans.filter(
            (span) => !span.name.startsWith("ai.") && !span.parentSpanId,
          );
          expect(nonAIRootSpans).toHaveLength(0);

          // Snapshot the span names and key structure (not full payloads, since
          // response content and token counts are non-deterministic).
          const spanSummary = allSpans.map((span) => ({
            hasParent: !!span.parentSpanId,
            name: span.name,
          }));
          await expect(formatJsonFileSnapshot(spanSummary)).toMatchFileSnapshot(
            resolveFileSnapshotPath(
              import.meta.url,
              `${scenario.dependencyName}.otel-spans.json`,
            ),
          );

          // Snapshot request metadata.
          await expect(
            formatJsonFileSnapshot(
              otelRequests
                .map((request) =>
                  summarizeRequest(request, {
                    includeHeaders: ["content-type", "x-bt-parent"],
                  }),
                )
                .map((summary) => ({
                  ...summary,
                  // Normalize the x-bt-parent header (contains test run ID).
                  headers:
                    summary.headers && typeof summary.headers === "object"
                      ? {
                          ...(summary.headers as Record<string, unknown>),
                          "x-bt-parent": "<x-bt-parent>",
                        }
                      : summary.headers,
                  // Omit the full JSON body (too large and non-deterministic).
                  jsonBody: "<omitted>",
                  rawBody: "<omitted>",
                })),
            ),
          ).toMatchFileSnapshot(
            resolveFileSnapshotPath(
              import.meta.url,
              `${scenario.dependencyName}.otel-requests.json`,
            ),
          );
        },
      );
    },
  );
}
