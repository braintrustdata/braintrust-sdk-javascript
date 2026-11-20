import { describe, expect, test } from "vite-plus/test";
import { describeVariant } from "../../helpers/describe-variant";
import { resolve } from "node:path";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
  withScenarioHarness,
} from "../../helpers/scenario-harness";
import { findAllSpans } from "../../helpers/trace-selectors";
import { defineGroqInstrumentationAssertions } from "./assertions";
import { GROQ_SCENARIO_TIMEOUT_MS } from "./scenario.impl.mjs";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const audioFile = resolve(
  originalScenarioDir,
  "../google-genai-instrumentation/test-audio.wav",
);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});
const groqScenarios = await Promise.all(
  [
    {
      dependencyName: "groq-sdk-v1",
      snapshotName: "groq-v1",
    },
    {
      dependencyName: "groq-sdk-v1-latest",
      snapshotName: "groq-v1-latest",
    },
  ].map(async (scenario) => ({
    ...scenario,
    version: await readInstalledPackageVersion(
      scenarioDir,
      scenario.dependencyName,
    ),
  })),
);

describe.concurrent("variants", () => {
  for (const scenario of groqScenarios) {
    describeVariant(`groq sdk ${scenario.version}`, () => {
      test.each(["wrapped", "auto"])(
        "traces batch operations (%s)",
        async (mode) => {
          await withScenarioHarness(async (harness) => {
            await harness.runNodeScenarioDir({
              entry: "batch.mjs",
              scenarioDir,
              nodeArgs:
                mode === "auto" ? ["--import", "braintrust/hook.mjs"] : [],
              env: {
                GROQ_PACKAGE_NAME: scenario.dependencyName,
                GROQ_WRAP: String(mode === "wrapped"),
              },
            });
            const events = harness.events();
            const creates = findAllSpans(events, "groq.batches.create");
            expect(creates).toHaveLength(1);
            expect(creates[0].input).toEqual({
              endpoint: "/v1/chat/completions",
              input_file_id: "file-input",
              completion_window: "24h",
            });
            expect(creates[0].output).toEqual({
              id: "batch-test",
              status: "validating",
            });
            const polls = findAllSpans(events, "groq.batches.retrieve");
            expect(polls).toHaveLength(2);
            expect(polls).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  input: { id: "batch-test" },
                  output: {
                    id: "batch-test",
                    status: "completed",
                    request_counts: { total: 1, completed: 1, failed: 0 },
                  },
                }),
                expect.objectContaining({
                  input: { id: "missing" },
                  row: expect.objectContaining({
                    error: expect.stringContaining("unknown batch"),
                  }),
                }),
              ]),
            );
          });
        },
        GROQ_SCENARIO_TIMEOUT_MS,
      );

      defineGroqInstrumentationAssertions({
        name: "wrapped instrumentation",
        runScenario: async ({ runScenarioDir }) => {
          await runScenarioDir({
            entry: "scenario.ts",
            env: {
              BRAINTRUST_AUTO_CAPTURE_ATTACHMENTS: "true",
              GROQ_AUDIO_FILE: audioFile,
              GROQ_PACKAGE_NAME: scenario.dependencyName,
            },
            runContext: {
              variantKey: `${scenario.snapshotName}-wrapped`,
              originalScenarioDir,
            },
            scenarioDir,
            timeoutMs: GROQ_SCENARIO_TIMEOUT_MS,
          });
        },
        snapshotName: `${scenario.snapshotName}-wrapped`,
        testFileUrl: import.meta.url,
        timeoutMs: GROQ_SCENARIO_TIMEOUT_MS,
      });

      defineGroqInstrumentationAssertions({
        name: "auto-hook instrumentation",
        runScenario: async ({ runNodeScenarioDir }) => {
          await runNodeScenarioDir({
            entry: "scenario.mjs",
            env: {
              BRAINTRUST_AUTO_CAPTURE_ATTACHMENTS: "true",
              GROQ_AUDIO_FILE: audioFile,
              GROQ_PACKAGE_NAME: scenario.dependencyName,
            },
            nodeArgs: ["--import", "braintrust/hook.mjs"],
            runContext: {
              variantKey: `${scenario.snapshotName}-auto`,
              originalScenarioDir,
            },
            scenarioDir,
            timeoutMs: GROQ_SCENARIO_TIMEOUT_MS,
          });
        },
        snapshotName: `${scenario.snapshotName}-auto`,
        testFileUrl: import.meta.url,
        timeoutMs: GROQ_SCENARIO_TIMEOUT_MS,
      });
    });
  }
});
