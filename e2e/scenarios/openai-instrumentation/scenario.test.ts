import { describe, expect, it } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
  runNodeScenarioDir,
  withScenarioHarness,
} from "../../helpers/scenario-harness";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";
import { matchSpanTreeSnapshot, spanTreeFields } from "../../helpers/span-tree";
import {
  findAllSpans,
  spanInstrumentationName,
} from "../../helpers/trace-selectors";
import { defineOpenAIInstrumentationAssertions } from "./assertions";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});
const TIMEOUT_MS = 120_000;
const openaiScenarios = await Promise.all(
  [
    {
      autoEntry: "scenario.openai-v4.mjs",
      dependencyName: "openai-v4",
      disablePrivateFieldMethodsAssertion: true,
      snapshotName: "openai-v4",
      wrapperEntry: "scenario.openai-v4.ts",
    },
    {
      autoEntry: "scenario.openai-v4.mjs",
      dependencyName: "openai-v4-latest",
      disablePrivateFieldMethodsAssertion: true,
      snapshotName: "openai-v4-latest",
      wrapperEntry: "scenario.openai-v4.ts",
    },
    {
      autoEntry: "scenario.openai-v5.mjs",
      dependencyName: "openai-v5",
      disablePrivateFieldMethodsAssertion: true,
      snapshotName: "openai-v5",
      wrapperEntry: "scenario.openai-v5.ts",
    },
    {
      autoEntry: "scenario.openai-v5.mjs",
      dependencyName: "openai-v5-latest",
      disablePrivateFieldMethodsAssertion: true,
      snapshotName: "openai-v5-latest",
      wrapperEntry: "scenario.openai-v5.ts",
    },
    {
      autoEntry: "scenario.mjs",
      dependencyName: "openai-v6",
      snapshotName: "openai-v6",
      wrapperEntry: "scenario.ts",
    },
    {
      autoEntry: "scenario.mjs",
      dependencyName: "openai-v6-latest",
      snapshotName: "openai-v6-latest",
      wrapperEntry: "scenario.ts",
    },
  ].map(async (scenario) => ({
    ...scenario,
    version: await readInstalledPackageVersion(
      scenarioDir,
      scenario.dependencyName,
    ),
  })),
);

// Regression test: verify hook.mjs doesn't cause "Body already read" with real undici responses.
// The cassette layer returns in-process Response mocks that mask this bug; this test bypasses it.
describe("real HTTP server (undici responses)", () => {
  it(
    "hook.mjs does not cause 'Body already read' on non-streaming create()",
    async () => {
      await runNodeScenarioDir({
        entry: "scenario.real-http.mjs",
        nodeArgs: ["--import", "braintrust/hook.mjs"],
        scenarioDir,
        timeoutMs: TIMEOUT_MS,
      });
    },
    TIMEOUT_MS,
  );
});

describe.concurrent("variants", () => {
  for (const scenario of openaiScenarios) {
    const assertPrivateFieldMethodsOperation =
      !scenario.disablePrivateFieldMethodsAssertion;

    describe.sequential(`openai sdk ${scenario.version}`, () => {
      for (const mode of ["wrapped", "auto-hook"]) {
        it(
          `preserves DeepSeek streamed reasoning with ${mode} instrumentation`,
          async () => {
            await withScenarioHarness(async (harness) => {
              const variantKey = `${scenario.snapshotName}-reasoning`;
              const result = await harness.runNodeScenarioDir({
                entry: "scenario.reasoning.mjs",
                env: {
                  OPENAI_PACKAGE_NAME: scenario.dependencyName,
                  INSTRUMENTATION_MODE: mode,
                },
                nodeArgs:
                  mode === "auto-hook"
                    ? ["--import", "braintrust/hook.mjs"]
                    : [],
                runContext: { variantKey, originalScenarioDir },
                scenarioDir,
                timeoutMs: TIMEOUT_MS,
              });
              const received: {
                reasoning: string[];
                content: string[];
                usage: {
                  prompt_tokens: number;
                  completion_tokens: number;
                  total_tokens: number;
                };
              } = JSON.parse(result.stdout);
              expect(received.reasoning.length).toBeGreaterThan(1);
              expect(received.content.join("").trim()).toBe("9.8");

              const events = harness.events();
              const roots = findAllSpans(events, "openai-reasoning-root");
              const spans = findAllSpans(events, "Chat Completion");
              expect(roots).toHaveLength(1);
              expect(spans).toHaveLength(1);
              const span = spans[0];
              expect(span.span.parentIds).toEqual([roots[0].span.id]);
              expect(spanInstrumentationName(span)).toBe("openai");
              expect(span.output).toMatchObject([
                {
                  index: 0,
                  finish_reason: "stop",
                  message: {
                    role: "assistant",
                    content: received.content.join(""),
                  },
                },
              ]);
              expect(span.output).toMatchObject([
                {
                  message: { reasoning_content: received.reasoning.join("") },
                },
              ]);
              expect(span.metrics).toMatchObject({
                prompt_tokens: received.usage.prompt_tokens,
                completion_tokens: received.usage.completion_tokens,
                tokens: received.usage.total_tokens,
              });
              await matchSpanTreeSnapshot(
                [...roots, ...spans].map((event) => ({
                  event,
                  fields: { ...spanTreeFields(event), context: event.context },
                })),
                resolveFileSnapshotPath(
                  import.meta.url,
                  `${variantKey}-${mode}.span-tree.json`,
                ),
              );
            });
          },
          TIMEOUT_MS,
        );
      }

      defineOpenAIInstrumentationAssertions({
        assertPrivateFieldMethodsOperation,
        name: "wrapped instrumentation",
        runScenario: async ({ runScenarioDir }) => {
          await runScenarioDir({
            entry: scenario.wrapperEntry,
            env: {
              BRAINTRUST_CAPTURE_ATTACHMENTS: "true",
              OPENAI_PACKAGE_NAME: scenario.dependencyName,
            },
            runContext: {
              variantKey: scenario.snapshotName,
              originalScenarioDir,
            },
            scenarioDir,
            timeoutMs: TIMEOUT_MS,
          });
        },
        snapshotName: `${scenario.snapshotName}-wrapped`,
        cassetteName: scenario.snapshotName,
        testFileUrl: import.meta.url,
        timeoutMs: 300_000,
        version: scenario.version,
      });

      defineOpenAIInstrumentationAssertions({
        name: "auto-hook instrumentation",
        runScenario: async ({ runNodeScenarioDir }) => {
          await runNodeScenarioDir({
            entry: scenario.autoEntry,
            env: {
              BRAINTRUST_CAPTURE_ATTACHMENTS: "true",
              OPENAI_PACKAGE_NAME: scenario.dependencyName,
            },
            nodeArgs: ["--import", "braintrust/hook.mjs"],
            runContext: {
              variantKey: scenario.snapshotName,
              originalScenarioDir,
            },
            scenarioDir,
            timeoutMs: TIMEOUT_MS,
          });
        },
        snapshotName: `${scenario.snapshotName}-auto-hook`,
        cassetteName: scenario.snapshotName,
        testFileUrl: import.meta.url,
        timeoutMs: 300_000,
        version: scenario.version,
      });
    });
  }
});
