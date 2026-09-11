import {
  findAllSpans,
  findChildSpans,
  findLatestSpan,
} from "../../helpers/trace-selectors";
import { describe, expect, it } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
  withScenarioHarness,
} from "../../helpers/scenario-harness";
import { matchSpanTreeSnapshot, spanTreeFields } from "../../helpers/span-tree";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});
const variants = await Promise.all(
  ["langgraph-sdk-v1", "langgraph-sdk-v1-latest"].map(async (dependency) => ({
    dependency,
    version: await readInstalledPackageVersion(scenarioDir, dependency),
  })),
);

describe.concurrent("variants", () => {
  for (const { dependency, version } of variants) {
    describe.sequential(`LangGraph SDK ${version} (${dependency})`, () => {
      for (const module of ["esm", "cjs"]) {
        for (const mode of ["wrapped", "auto", "both", "disabled"]) {
          it(`${module} ${mode}`, async () => {
            await withScenarioHarness(
              async (harness) => {
                const result = await harness.runNodeScenarioDir({
                  scenarioDir,
                  entry: "scenario.mjs",
                  timeoutMs: 120_000,
                  env: {
                    LANGGRAPH_SDK_PACKAGE: dependency,
                    LANGGRAPH_SDK_VERSION: version,
                    LANGGRAPH_SDK_MODULE: module,
                    LANGGRAPH_SDK_MODE: mode,
                    ...(mode === "disabled"
                      ? { BRAINTRUST_DISABLE_INSTRUMENTATION: "langgraph-sdk" }
                      : {}),
                  },
                  nodeArgs:
                    mode === "wrapped"
                      ? []
                      : ["--import", "braintrust/hook.mjs"],
                  // The real server and graph run in every lane. Only model HTTP
                  // responses are recorded and replayed by the harness.
                  runContext: { originalScenarioDir, variantKey: dependency },
                });
                const usageLine = result.stdout
                  .split("\n")
                  .find((line) =>
                    line.startsWith("LANGGRAPH_EXPECTED_USAGE "),
                  )!;
                const expectedUsage = JSON.parse(
                  usageLine.slice("LANGGRAPH_EXPECTED_USAGE ".length),
                );
                const rawEvents = harness.events();
                const events = [
                  ...new Set(rawEvents.map((event) => event.span.name)),
                ].flatMap((name) =>
                  name ? findAllSpans(rawEvents, name) : [],
                );
                const instrumented = events.filter((event) =>
                  event.span.name?.startsWith("langgraph.runs."),
                );
                const root = events.find(
                  (event) =>
                    event.metadata?.scenario ===
                    "langgraph-sdk-instrumentation",
                )!;
                expect(root.metadata).toMatchObject({
                  sdk_version: version,
                  module,
                  instrumentation_mode: mode,
                  expected_error_cases: 4,
                });
                expect(root.output).toEqual({
                  status: "passed",
                  expected_error_cases: 4,
                });
                expect(events.every((event) => event.span.ended)).toBe(true);
                const operationSpecs = [
                  [
                    "background",
                    "Uninstrumented background APIs",
                    "background-apis",
                  ],
                  ["wait", "Wait for final result", "wait"],
                  [
                    "interruptResume",
                    "Interrupt and resume",
                    "interrupt-resume",
                  ],
                  ["values", "Stream values mode", "values"],
                  ["messages", "Stream messages mode", "messages"],
                  ["updates", "Stream updates mode", "updates"],
                  ["streamError", "Stream error", "stream-error"],
                  ["cancel", "Cancel stream", "cancel"],
                  [
                    "missingAssistant",
                    "Missing assistant error",
                    "missing-assistant-error",
                  ],
                  ["thrownError", "Thrown graph error", "thrown-error"],
                  ["returnedError", "Returned graph error", "returned-error"],
                  ["concurrent", "Concurrent waits", "concurrent-waits"],
                ] as const;
                const operations = Object.fromEntries(
                  operationSpecs.map(([key, spanName, operation]) => {
                    const event = findLatestSpan(rawEvents, spanName)!;
                    expect(event.span.parentIds).toEqual([root.span.id]);
                    expect(event.metadata).toMatchObject({ operation });
                    return [key, event];
                  }),
                ) as Record<
                  (typeof operationSpecs)[number][0],
                  (typeof events)[number]
                >;
                expect(
                  events.filter((event) =>
                    event.span.parentIds.includes(
                      operations.background.span.id!,
                    ),
                  ),
                ).toEqual([]);
                if (mode === "disabled") {
                  expect(instrumented).toHaveLength(0);
                  expect(events).toHaveLength(13);
                  return;
                }
                expect(events).toHaveLength(26);
                expect(instrumented).toHaveLength(13);
                expect(
                  instrumented.filter((event) => event.row.error),
                ).toHaveLength(4);
                for (const event of instrumented) {
                  expect(event.span.type).toBe("task");
                  expect(event.context?.span_origin).toMatchObject({
                    instrumentation: { name: "langgraph-sdk" },
                  });
                  expect(event.span.parentIds).toHaveLength(1);
                }
                const wait = findChildSpans(
                  rawEvents,
                  "langgraph.runs.wait",
                  operations.wait.span.id,
                );
                const interruptResume = findChildSpans(
                  rawEvents,
                  "langgraph.runs.wait",
                  operations.interruptResume.span.id,
                );
                const values = findChildSpans(
                  rawEvents,
                  "langgraph.runs.stream",
                  operations.values.span.id,
                );
                const messages = findChildSpans(
                  rawEvents,
                  "langgraph.runs.stream",
                  operations.messages.span.id,
                );
                const updates = findChildSpans(
                  rawEvents,
                  "langgraph.runs.stream",
                  operations.updates.span.id,
                );
                const streamError = findChildSpans(
                  rawEvents,
                  "langgraph.runs.stream",
                  operations.streamError.span.id,
                );
                const cancel = findChildSpans(
                  rawEvents,
                  "langgraph.runs.stream",
                  operations.cancel.span.id,
                );
                const missingAssistant = findChildSpans(
                  rawEvents,
                  "langgraph.runs.wait",
                  operations.missingAssistant.span.id,
                );
                const thrownError = findChildSpans(
                  rawEvents,
                  "langgraph.runs.wait",
                  operations.thrownError.span.id,
                );
                const returnedError = findChildSpans(
                  rawEvents,
                  "langgraph.runs.wait",
                  operations.returnedError.span.id,
                );
                const concurrent = findChildSpans(
                  rawEvents,
                  "langgraph.runs.wait",
                  operations.concurrent.span.id,
                );
                for (const group of [
                  wait,
                  values,
                  messages,
                  updates,
                  streamError,
                  cancel,
                  missingAssistant,
                  thrownError,
                  returnedError,
                ])
                  expect(group).toHaveLength(1);
                expect(interruptResume).toHaveLength(2);
                expect(concurrent).toHaveLength(2);
                const cases = {
                  wait: wait[0],
                  resume: interruptResume[1],
                  values: values[0],
                  messages: messages[0],
                  updates: updates[0],
                  left: concurrent.find((event) =>
                    JSON.stringify(event.input).includes("exactly: left"),
                  )!,
                  right: concurrent.find((event) =>
                    JSON.stringify(event.input).includes("exactly: right"),
                  )!,
                };
                for (const [name, event] of Object.entries(cases)) {
                  const usage = expectedUsage[name];
                  expect(event.metrics).toMatchObject({
                    prompt_tokens: usage.input_tokens,
                    completion_tokens: usage.output_tokens,
                    tokens: usage.total_tokens,
                  });
                  expect(event.output).toEqual({
                    role: "assistant",
                    content:
                      name === "left" || name === "right"
                        ? name
                        : "hello from langgraph",
                  });
                }
                for (const name of ["values", "messages", "updates"] as const)
                  expect(
                    cases[name].metrics?.time_to_first_token,
                  ).toBeGreaterThanOrEqual(0);
                for (const name of ["values", "messages", "updates"] as const)
                  expect(cases[name].output).toEqual(cases.wait.output);
                expect(interruptResume[0].output).toBeUndefined();
                expect(interruptResume[0].metadata).toMatchObject({
                  "langgraph.interrupts": [
                    { value: "Approve the model call?" },
                  ],
                });
                expect(interruptResume[1].input).toEqual({
                  command: { resume: "yes" },
                });
                expect(missingAssistant[0].row.error).toContain("HTTP 404");
                expect(thrownError[0].row.error).toBe("Agent failed");
                expect(returnedError[0].output).toBeUndefined();
                expect(returnedError[0].row.error).toBe("Agent failed");
                const serialized = JSON.stringify(instrumented);
                for (const field of [
                  "DO_NOT_CAPTURE",
                  "additional_kwargs",
                  "response_metadata",
                  "usage_metadata",
                  "invalid_tool_calls",
                  "tool_call_chunks",
                ])
                  expect(serialized).not.toContain(field);
                await matchSpanTreeSnapshot(
                  events.map((event) => ({
                    event,
                    fields: {
                      ...spanTreeFields(event),
                      context: event.context,
                    },
                  })),
                  resolveFileSnapshotPath(
                    import.meta.url,
                    `${dependency}-${module}-${mode}.span-tree.json`,
                  ),
                );
              },
              {
                // Keep every mode's assertions, but publish one representative
                // trace per version so CI links do not contain duplicate/empty runs.
                forwardToProduction: module === "esm" && mode === "wrapped",
              },
            );
          }, 120_000);
        }
      }
    });
  }
});
