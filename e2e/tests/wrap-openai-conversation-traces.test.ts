import { expect, test } from "vitest";
import { normalizeForSnapshot, type Json } from "./helpers/normalize";
import {
  OPENAI_SCENARIO_TIMEOUT_MS,
  WRAP_OPENAI_SCENARIOS,
  summarizeOpenAIContract,
} from "./helpers/openai";
import { withScenarioHarness } from "./helpers/scenario-harness";
import { findLatestChildSpan, findLatestSpan } from "./helpers/trace-selectors";

test.each(
  WRAP_OPENAI_SCENARIOS.map(
    ({ scenarioPath, version }) => [version, scenarioPath] as const,
  ),
)(
  "wrap-openai-conversation-traces logs wrapped chat and responses traces (openai %s)",
  async (version, scenarioPath) => {
    await withScenarioHarness(async ({ events, runScenario }) => {
      await runScenario(scenarioPath, OPENAI_SCENARIO_TIMEOUT_MS);

      const capturedEvents = events();

      const root = findLatestSpan(capturedEvents, "openai-wrapper-root");
      const chatOperation = findLatestSpan(
        capturedEvents,
        "openai-chat-operation",
      );
      const streamOperation = findLatestSpan(
        capturedEvents,
        "openai-stream-operation",
      );
      const responsesOperation = findLatestSpan(
        capturedEvents,
        "openai-responses-operation",
      );
      const chatCompletionSpan = findLatestChildSpan(
        capturedEvents,
        "Chat Completion",
        chatOperation?.span.id,
      );
      const streamCompletionSpan = findLatestChildSpan(
        capturedEvents,
        "Chat Completion",
        streamOperation?.span.id,
      );
      const responsesSpan = findLatestChildSpan(
        capturedEvents,
        "openai.responses.create",
        responsesOperation?.span.id,
      );

      expect(root).toBeDefined();
      expect(chatOperation).toBeDefined();
      expect(streamOperation).toBeDefined();
      expect(responsesOperation).toBeDefined();
      expect(chatCompletionSpan).toBeDefined();
      expect(streamCompletionSpan).toBeDefined();
      expect(responsesSpan).toBeDefined();
      expect(root?.row.metadata).toMatchObject({
        openaiSdkVersion: version,
      });
      expect(chatOperation?.row.metadata).toMatchObject({
        operation: "chat",
      });
      expect(streamOperation?.row.metadata).toMatchObject({
        operation: "stream",
      });
      expect(responsesOperation?.row.metadata).toMatchObject({
        operation: "responses",
      });
      expect(chatCompletionSpan?.row.metadata).toMatchObject({
        provider: "openai",
      });
      expect(
        typeof (
          chatCompletionSpan?.row.metadata as { model?: unknown } | undefined
        )?.model,
      ).toBe("string");
      expect(streamCompletionSpan?.row.metadata).toMatchObject({
        provider: "openai",
      });
      expect(
        typeof (
          streamCompletionSpan?.row.metadata as { model?: unknown } | undefined
        )?.model,
      ).toBe("string");
      expect(responsesSpan?.row.metadata).toMatchObject({
        provider: "openai",
      });
      expect(
        typeof (responsesSpan?.row.metadata as { model?: unknown } | undefined)
          ?.model,
      ).toBe("string");

      expect(chatOperation?.span.parentIds).toEqual([root?.span.id ?? ""]);
      expect(streamOperation?.span.parentIds).toEqual([root?.span.id ?? ""]);
      expect(responsesOperation?.span.parentIds).toEqual([root?.span.id ?? ""]);
      expect(chatCompletionSpan?.span.parentIds).toEqual([
        chatOperation?.span.id ?? "",
      ]);
      expect(streamCompletionSpan?.span.parentIds).toEqual([
        streamOperation?.span.id ?? "",
      ]);
      expect(responsesSpan?.span.parentIds).toEqual([
        responsesOperation?.span.id ?? "",
      ]);
      expect(chatCompletionSpan?.input).toBeDefined();
      expect(chatCompletionSpan?.output).toBeDefined();
      expect(streamCompletionSpan?.output).toBeDefined();
      expect(streamCompletionSpan?.metrics).toBeDefined();
      expect(responsesSpan?.output).toBeDefined();

      expect(
        normalizeForSnapshot(
          [
            root,
            chatOperation,
            chatCompletionSpan,
            streamOperation,
            streamCompletionSpan,
            responsesOperation,
            responsesSpan,
          ].map((event) => summarizeOpenAIContract(event!)) as Json,
        ),
      ).toMatchSnapshot("span-events");
    });
  },
);
