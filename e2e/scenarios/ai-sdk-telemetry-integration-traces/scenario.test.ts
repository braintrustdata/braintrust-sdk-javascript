import { describe, expect, test } from "vitest";
import { normalizeForSnapshot, type Json } from "../../helpers/normalize";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import {
  prepareScenarioDir,
  withScenarioHarness,
} from "../../helpers/scenario-harness";
import { resolveScenarioDir } from "../../helpers/scenario-harness";
import {
  findAllSpans,
  findChildSpans,
  findLatestSpan,
} from "../../helpers/trace-selectors";
import { E2E_TAGS } from "../../helpers/tags";
import { ROOT_NAME } from "./scenario.impl";

const SCENARIO_TIMEOUT_MS = 30_000;

const scenarioDir = await prepareScenarioDir({
  scenarioDir: resolveScenarioDir(import.meta.url),
});

function summarizeSpan(event: CapturedLogEvent): Json {
  const row = event.row as Record<string, unknown>;
  return {
    name: event.span.name ?? null,
    type: event.span.type ?? null,
    has_input: event.input !== undefined && event.input !== null,
    has_output: event.output !== undefined && event.output !== null,
    has_error: row.error !== undefined && row.error !== null,
    metadata_keys: Object.keys(
      (row.metadata as Record<string, unknown>) ?? {},
    ).sort(),
    metric_keys: Object.keys((row.metrics as Record<string, unknown>) ?? {})
      .filter((k) => k !== "start" && k !== "end")
      .sort(),
  } satisfies Json;
}

describe("ai sdk telemetry integration traces", () => {
  test(
    "creates expected trace tree",
    {
      tags: [E2E_TAGS.hermetic],
      timeout: SCENARIO_TIMEOUT_MS,
    },
    async () => {
      await withScenarioHarness(async (harness) => {
        await harness.runScenarioDir({
          scenarioDir,
          timeoutMs: SCENARIO_TIMEOUT_MS,
        });

        const events = harness.events();
        expect(events.length).toBeGreaterThan(0);

        // Find the root span
        const rootSpan = findLatestSpan(events, ROOT_NAME);
        expect(rootSpan).toBeDefined();

        // --------------------------------------------------
        // 1. generateText with custom name and metadata
        // --------------------------------------------------
        const generateSpans = findAllSpans(events, "custom-generate-name");
        expect(generateSpans.length).toBe(1);
        const genSpan = generateSpans[0];

        // Verify custom metadata was plumbed through
        const genRow = genSpan.row as Record<string, unknown>;
        const genMeta = genRow.metadata as Record<string, unknown>;
        expect(genMeta?.user).toBe("test-user");
        expect(genMeta?.model).toBe("mock-model");
        expect(genMeta?.provider).toBe("mock-provider");

        // Verify braintrust integration marker
        const btMeta = genMeta?.braintrust as Record<string, unknown>;
        expect(btMeta?.integration_name).toBe("ai-sdk-telemetry");

        // Verify output was logged
        expect(genSpan.output).toBeDefined();

        // Verify step child spans exist
        const genSteps = findChildSpans(events, "step-0", genSpan.span.id);
        expect(genSteps.length).toBe(1);

        // --------------------------------------------------
        // 2. streamText with custom name
        // --------------------------------------------------
        const streamSpans = findAllSpans(events, "custom-stream-name");
        expect(streamSpans.length).toBe(1);
        const streamSpan = streamSpans[0];
        expect(streamSpan.output).toBeDefined();

        // Verify step child spans exist
        const streamSteps = findChildSpans(
          events,
          "step-0",
          streamSpan.span.id,
        );
        expect(streamSteps.length).toBe(1);

        // Verify time_to_first_token metric on step span
        const streamStepRow = streamSteps[0].row as Record<string, unknown>;
        const streamStepMetrics = streamStepRow.metrics as Record<
          string,
          unknown
        >;
        expect(streamStepMetrics?.time_to_first_token).toBeDefined();

        // --------------------------------------------------
        // 3. generateText with tool calls
        // --------------------------------------------------
        const toolGenSpans = findAllSpans(events, "tool-call-generate");
        expect(toolGenSpans.length).toBe(1);
        const toolGenSpan = toolGenSpans[0];

        // Should have step-0 (tool call) and step-1 (final response)
        const toolStep0 = findChildSpans(events, "step-0", toolGenSpan.span.id);
        expect(toolStep0.length).toBe(1);

        const toolStep1 = findChildSpans(events, "step-1", toolGenSpan.span.id);
        expect(toolStep1.length).toBe(1);

        // Should have a get_weather tool span
        const allToolSpans = findAllSpans(events, "get_weather");
        expect(allToolSpans.length).toBe(1);
        const weatherTool = allToolSpans[0];
        expect(weatherTool.span.type).toBe("tool");
        expect(weatherTool.output).toBeDefined();

        // Verify tool span has duration metric
        const toolRow = weatherTool.row as Record<string, unknown>;
        const toolMetrics = toolRow.metrics as Record<string, unknown>;
        expect(toolMetrics?.duration).toBeDefined();

        // --------------------------------------------------
        // 4. generateText with nested sub-agent tool calls
        // --------------------------------------------------
        const nestedToolGenSpans = findAllSpans(
          events,
          "nested-tool-call-generate",
        );
        expect(nestedToolGenSpans.length).toBe(1);
        const nestedToolGenSpan = nestedToolGenSpans[0];

        const nestedParentStep0 = findChildSpans(
          events,
          "step-0",
          nestedToolGenSpan.span.id,
        );
        expect(nestedParentStep0.length).toBe(1);

        const nestedParentStep1 = findChildSpans(
          events,
          "step-1",
          nestedToolGenSpan.span.id,
        );
        expect(nestedParentStep1.length).toBe(1);

        const nestedParentStep2 = findChildSpans(
          events,
          "step-2",
          nestedToolGenSpan.span.id,
        );
        expect(nestedParentStep2.length).toBe(1);

        const researchToolSpans = findChildSpans(
          events,
          "researchCity",
          nestedParentStep0[0].span.id,
        );
        expect(researchToolSpans.length).toBe(1);

        const secondResearchToolSpans = findChildSpans(
          events,
          "researchCity",
          nestedParentStep1[0].span.id,
        );
        expect(secondResearchToolSpans.length).toBe(1);

        const nestedSubagentRoot1 = findChildSpans(
          events,
          "generateText",
          researchToolSpans[0].span.id,
        );
        expect(nestedSubagentRoot1.length).toBe(1);

        const nestedSubagentRoot2 = findChildSpans(
          events,
          "generateText",
          secondResearchToolSpans[0].span.id,
        );
        expect(nestedSubagentRoot2.length).toBe(1);

        const nestedSubagentStep1 = findChildSpans(
          events,
          "step-0",
          nestedSubagentRoot1[0].span.id,
        );
        expect(nestedSubagentStep1.length).toBe(1);

        const nestedSubagentStep2 = findChildSpans(
          events,
          "step-0",
          nestedSubagentRoot2[0].span.id,
        );
        expect(nestedSubagentStep2.length).toBe(1);

        // --------------------------------------------------
        // 5. generateText with error
        // --------------------------------------------------
        const errorSpans = findAllSpans(events, "error-generate");
        expect(errorSpans.length).toBe(1);
        const errorSpan = errorSpans[0];
        const errorRow = errorSpan.row as Record<string, unknown>;
        expect(errorRow.error).toBeDefined();

        // --------------------------------------------------
        // Snapshot the full trace tree structure
        // --------------------------------------------------
        const allSpans = events
          .filter(
            (e) =>
              e.span.name !== ROOT_NAME &&
              e.span.rootId === rootSpan!.span.rootId,
          )
          .map(summarizeSpan);

        expect(normalizeForSnapshot(allSpans as Json)).toMatchSnapshot();
      });
    },
  );
});
