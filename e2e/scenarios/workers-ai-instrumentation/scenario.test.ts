import { describe, expect, test } from "vite-plus/test";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
  withScenarioHarness,
} from "../../helpers/scenario-harness";
import {
  findAllSpans,
  findLatestSpan,
  findChildSpans,
} from "../../helpers/trace-selectors";
import { matchSpanTreeSnapshot, spanTreeFields } from "../../helpers/span-tree";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});

for (const dependency of ["miniflare-v4", "miniflare-v4-latest"]) {
  const version = await readInstalledPackageVersion(scenarioDir, dependency);
  describe(`Workers AI native binding (${dependency}: ${version})`, () => {
    test("preserves native binding errors and concurrent workerd context", async () => {
      await withScenarioHarness(async (harness) => {
        await harness.runScenarioDir({
          scenarioDir,
          env: {
            MINIFLARE_PACKAGE_NAME: dependency,
            WORKERS_AI_BINDING_ONLY: "true",
          },
          runContext: {
            originalScenarioDir,
            variantKey: `${dependency}-binding`,
            cassette: false,
          },
          timeoutMs: 120_000,
        });
        const events = harness.events();
        expect(findAllSpans(events, "workers_ai.run")).toHaveLength(2);
        for (const name of ["binding-a", "binding-b"]) {
          const parent = findLatestSpan(events, name)!;
          const calls = findChildSpans(
            events,
            "workers_ai.run",
            parent.span.id,
          );
          expect(calls).toHaveLength(1);
          expect(calls[0].span.type).toBe("decision");
          expect(calls[0].row.error).toContain("BigInt");
          expect(calls[0].row.context).toMatchObject({
            span_origin: { instrumentation: { name: "workers-ai" } },
          });
        }
        await matchSpanTreeSnapshot(
          events.map((event) => ({
            event,
            fields: { ...spanTreeFields(event), context: event.row.context },
          })),
          resolveFileSnapshotPath(
            import.meta.url,
            `${dependency}-binding.span-tree.json`,
          ),
        );
      });
    }, 180_000);

    for (const capture of [false, true]) {
      test(`captures real decisions, extraction, media, errors and concurrent parents (attachments=${capture})`, async () => {
        await withScenarioHarness(async (harness) => {
          await harness.runScenarioDir({
            scenarioDir,
            env: {
              MINIFLARE_PACKAGE_NAME: dependency,
              BRAINTRUST_AUTO_CAPTURE_ATTACHMENTS: String(capture),
            },
            runContext: { originalScenarioDir, variantKey: dependency },
            timeoutMs: 180_000,
          });
          const events = harness.events();
          const calls = findAllSpans(events, "workers_ai.run");
          expect(calls).toHaveLength(7);
          for (const name of ["decision-a", "decision-b", "image-decision"]) {
            const parent = findLatestSpan(events, name)!;
            const [call] = findChildSpans(
              events,
              "workers_ai.run",
              parent.span.id,
            );
            expect(call.span.type).toBe("decision");
            expect(call.row.metadata).toMatchObject({
              provider: "cloudflare",
              model: "clef-flash",
            });
            expect(call.output).toMatchObject({ answers: expect.any(Array) });
            expect(call.metrics?.prompt_tokens).toBeGreaterThan(0);
            expect(call.metrics?.completion_tokens).toBe(0);
            expect(call.metrics?.tokens).toBe(call.metrics?.prompt_tokens);
            expect(call.row.context).toMatchObject({
              span_origin: { instrumentation: { name: "workers-ai" } },
            });
          }
          const mixed = findChildSpans(
            events,
            "workers_ai.run",
            findLatestSpan(events, "decision-a")!.span.id,
          )[0];
          expect(mixed.output).toMatchObject({
            answers: expect.arrayContaining([
              expect.objectContaining({
                id: "urgent",
                type: "noul",
                noul: expect.any(Number),
              }),
              expect.objectContaining({
                id: "team",
                type: "choice",
                probabilities: expect.any(Object),
              }),
              expect.objectContaining({
                id: "impact",
                type: "score",
                score: expect.any(Number),
              }),
            ]),
          });
          const extracted = findChildSpans(
            events,
            "workers_ai.run",
            findLatestSpan(events, "extraction")!.span.id,
          )[0];
          expect(extracted.span.type).toBe("extraction");
          expect(extracted.input).toMatchObject({
            state: expect.stringContaining("Invoice INV-42"),
            fields: expect.arrayContaining([
              {
                id: "delivery",
                type: "duration",
                unit: "days",
                instructions: "Delivery duration",
              },
              expect.objectContaining({
                id: "forecast",
                type: "forecast",
                horizon: 2,
                interval: "day",
                min: 0,
              }),
            ]),
            options: { include_quantiles: true, return_state_text: true },
            reference_date: "2026-10-23",
          });
          expect(extracted.output).toMatchObject({
            answers: expect.arrayContaining([
              expect.objectContaining({
                id: "invoice",
                type: "text",
                value: expect.any(String),
                span: expect.any(Array),
              }),
              expect.objectContaining({
                id: "total",
                type: "number",
                value: expect.any(Number),
              }),
              expect.objectContaining({
                id: "missing",
                value: null,
                guess: expect.any(String),
                span: expect.any(Array),
              }),
              expect.objectContaining({
                id: "estimate",
                type: "estimate",
                value: expect.any(Number),
                quantiles: expect.anything(),
              }),
              expect.objectContaining({
                id: "forecast",
                type: "forecast",
                value: expect.any(Array),
                steps: expect.any(Array),
              }),
            ]),
            truncated: expect.any(Boolean),
            state_text: expect.any(String),
          });
          expect(extracted.metrics?.prompt_tokens).toBeGreaterThan(0);
          expect(extracted.metrics?.completion_tokens).toBe(0);
          expect(extracted.metrics?.tokens).toBe(
            extracted.metrics?.prompt_tokens,
          );
          expect(extracted.metrics).not.toHaveProperty("passes");
          expect(extracted.metrics).not.toHaveProperty("time_to_first_token");
          expect(extracted.row).not.toHaveProperty("scores");
          const imageExtraction = findChildSpans(
            events,
            "workers_ai.run",
            findLatestSpan(events, "image-extraction")!.span.id,
          )[0];
          expect(imageExtraction.span.type).toBe("extraction");
          const imageData = capture
            ? {
                type: "braintrust_attachment",
                content_type: "image/png",
                key: expect.any(String),
              }
            : "<omitted>";
          expect(imageExtraction.input).toMatchObject({
            state: null,
            images: [{ type: "file", mediaType: "image/png", data: imageData }],
          });
          const error = findChildSpans(
            events,
            "workers_ai.run",
            findLatestSpan(events, "provider-error")!.span.id,
          )[0];
          expect(error.row.error).toBeTruthy();
          expect(error.metrics?.end).toBeGreaterThan(0);
          const extractionError = findChildSpans(
            events,
            "workers_ai.run",
            findLatestSpan(events, "extraction-error")!.span.id,
          )[0];
          expect(extractionError.span.type).toBe("extraction");
          expect(extractionError.row.error).toBeTruthy();
          expect(extractionError.span.ended).toBe(true);
          expect(extractionError.output).toBeUndefined();
          const raw = findLatestSpan(events, "raw-response")!;
          expect(
            findChildSpans(events, "workers_ai.run", raw.span.id),
          ).toHaveLength(0);
          const image = findChildSpans(
            events,
            "workers_ai.run",
            findLatestSpan(events, "image-decision")!.span.id,
          )[0];
          expect(image.input).toMatchObject({
            state: {
              images: [
                { type: "file", mediaType: "image/png", data: imageData },
              ],
            },
          });
          await matchSpanTreeSnapshot(
            events.map((event) => ({
              event,
              fields: { ...spanTreeFields(event), context: event.row.context },
            })),
            resolveFileSnapshotPath(
              import.meta.url,
              `${dependency}${capture ? "-attachments" : ""}.span-tree.json`,
            ),
          );
        });
      }, 240_000);
    }
  });
}
