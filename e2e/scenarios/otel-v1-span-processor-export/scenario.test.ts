import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
  withScenarioHarness,
} from "../../helpers/scenario-harness";
import { extractOtelSpans } from "../../helpers/trace-summary";

const scenarioDir = await prepareScenarioDir({
  scenarioDir: resolveScenarioDir(import.meta.url),
});
const require = createRequire(import.meta.url);
const otelSdkVersion = await readInstalledPackageVersion(
  scenarioDir,
  "@opentelemetry/sdk-trace-base",
);
const braintrustOtelEntry = require.resolve("@braintrust/otel");
const otlpExporterManifestPath = require.resolve(
  "@opentelemetry/exporter-trace-otlp-http/package.json",
  {
    paths: [braintrustOtelEntry],
  },
);
const otlpExporterManifest = JSON.parse(
  await readFile(otlpExporterManifestPath, "utf8"),
) as { version: string };
const otlpExporterVersion = otlpExporterManifest.version;

type OtlpTraceRequest = {
  resourceSpans?: Array<{
    scopeSpans?: Array<{
      scope?: {
        name?: string;
        version?: string;
      };
      spans?: Array<{
        name?: string;
      }>;
    }>;
  }>;
};

test(`otel-v1-span-processor-export exports real OTel ${otelSdkVersion} spans through OTLP exporter ${otlpExporterVersion}`, async () => {
  expect(otelSdkVersion).toMatch(/^1\./);
  expect(Number(otlpExporterVersion.split(".")[1])).toBeGreaterThanOrEqual(200);

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
      const rootSpan = spans.find((span) => span.name === "otel-v1-root");
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
      expect(rootSpan?.spanId).toBeDefined();
      expect(compatSpan?.parentSpanId).toBe(rootSpan?.spanId);
      expect(compatSpan?.attributes["gen_ai.system"]).toBe("openai");
      expect(compatSpan?.attributes.testRunId).toBe(testRunId);
    },
  );
});
