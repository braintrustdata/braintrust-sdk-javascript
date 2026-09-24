import { expect, test } from "vitest";
import { withScenarioHarness } from "./scenario-harness";
import { findLatestSpan } from "./trace-selectors";
import { captureCases } from "./attachment-capture-scenario.mjs";

export function defineAttachmentCaptureTests(options: {
  scenarioDir: string;
  originalScenarioDir: string;
  provider: "openai" | "anthropic" | "elevenlabs";
  packageName: string;
  variantKey: string;
}) {
  for (const mode of ["wrapped", "auto"]) {
    test(`attachment capture policies (${options.variantKey}, ${mode})`, async () => {
      await withScenarioHarness(async (harness) => {
        await harness.runNodeScenarioDir({
          scenarioDir: options.scenarioDir,
          entry: "scenario.capture.mjs",
          nodeArgs: mode === "auto" ? ["--import", "braintrust/hook.mjs"] : [],
          env: {
            CAPTURE_PACKAGE_NAME: options.packageName,
            CAPTURE_WRAPPED: String(mode === "wrapped"),
            BRAINTRUST_CAPTURE_ATTACHMENTS: "",
          },
          runContext: {
            variantKey: options.variantKey,
            originalScenarioDir: options.originalScenarioDir,
            // The same Chat Completions request works on all supported SDK majors.
            // Its real-provider recording lives in the existing v6 media cassette.
            ...(options.provider === "openai"
              ? { cassette: { variantKey: "openai-v6" } }
              : {}),
          },
          timeoutMs: 180_000,
        });
        const events = harness.events();
        for (const testCase of captureCases) {
          const root = findLatestSpan(
            events,
            `attachment-capture-${testCase.name}`,
          );
          expect(root).toBeDefined();
          const children = events.filter(
            (event) =>
              event.row.root_span_id === root?.row.root_span_id &&
              event.span.id !== root?.span.id,
          );
          expect(children.length).toBeGreaterThan(0);
          const payload = JSON.stringify(children);
          if (testCase.enabled)
            expect(payload).toContain("braintrust_attachment");
          else {
            expect(payload).not.toContain("braintrust_attachment");
            expect(payload).not.toContain('"file_data":');
            expect(payload).not.toContain('"b64_json":');
            expect(payload).not.toContain('"data":');
            expect(payload).not.toContain("data:image/png;base64,");
          }
          if (options.provider === "elevenlabs") {
            expect(payload).toContain("time_to_first_token");
            expect(payload).toContain("annotations");
            expect(payload).not.toContain("audioBase64");
          } else {
            expect(payload).toContain("completion_tokens");
            expect(
              children.some((event) => event.row.output !== undefined),
            ).toBe(true);
          }
        }
      });
    }, 240_000);
  }
}
