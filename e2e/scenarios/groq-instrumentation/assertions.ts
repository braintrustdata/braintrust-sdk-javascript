import { beforeAll, describe, expect, test } from "vitest";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";
import {
  withScenarioHarness,
  type ScenarioRunContext,
} from "../../helpers/scenario-harness";
import { matchSpanTreeSnapshot } from "../../helpers/span-tree";
import { findChildSpans, findLatestSpan } from "../../helpers/trace-selectors";
import {
  AUDIO_MODEL,
  REASONING_MODEL,
  ROOT_NAME,
  SCENARIO_NAME,
  TRANSLATION_MODEL,
} from "./constants.mjs";

type RunGroqScenario = (harness: {
  runNodeScenarioDir: (options: {
    entry: string;
    nodeArgs: string[];
    runContext?: ScenarioRunContext;
    scenarioDir: string;
    timeoutMs: number;
  }) => Promise<unknown>;
  runScenarioDir: (options: {
    entry: string;
    runContext?: ScenarioRunContext;
    scenarioDir: string;
    timeoutMs: number;
  }) => Promise<unknown>;
}) => Promise<void>;

function findGroqSpan(
  events: CapturedLogEvent[],
  parentId: string | undefined,
  spanName: string,
) {
  const spans = findChildSpans(events, spanName, parentId);
  return spans.find((candidate) => candidate.output !== undefined) ?? spans[0];
}

function spanTreeEvents(events: CapturedLogEvent[]): CapturedLogEvent[] {
  const chatOperation = findLatestSpan(events, "groq-chat-operation");
  const streamOperation = findLatestSpan(events, "groq-stream-operation");
  const reasoningStreamOperation = findLatestSpan(
    events,
    "groq-reasoning-stream-operation",
  );
  const toolOperation = findLatestSpan(events, "groq-tool-operation");
  const transcriptionOperation = findLatestSpan(
    events,
    "groq-transcription-operation",
  );
  const translationOperation = findLatestSpan(
    events,
    "groq-translation-operation",
  );

  return [
    findLatestSpan(events, ROOT_NAME),
    chatOperation,
    findGroqSpan(
      events,
      chatOperation?.span.id,
      "groq.chat.completions.create",
    ),
    streamOperation,
    findGroqSpan(
      events,
      streamOperation?.span.id,
      "groq.chat.completions.create",
    ),
    reasoningStreamOperation,
    findGroqSpan(
      events,
      reasoningStreamOperation?.span.id,
      "groq.chat.completions.create",
    ),
    toolOperation,
    findGroqSpan(
      events,
      toolOperation?.span.id,
      "groq.chat.completions.create",
    ),
    transcriptionOperation,
    findGroqSpan(
      events,
      transcriptionOperation?.span.id,
      "groq.audio.transcriptions.create",
    ),
    translationOperation,
    findGroqSpan(
      events,
      translationOperation?.span.id,
      "groq.audio.translations.create",
    ),
  ].map((event) => event!);
}

export function defineGroqInstrumentationAssertions(options: {
  name: string;
  runScenario: RunGroqScenario;
  snapshotName: string;
  testFileUrl: string;
  timeoutMs: number;
}): void {
  const spanSnapshotPath = resolveFileSnapshotPath(
    options.testFileUrl,
    `${options.snapshotName}.span-tree.json`,
  );
  const testConfig = {
    timeout: options.timeoutMs,
  };

  describe(options.name, () => {
    let events: CapturedLogEvent[] = [];

    beforeAll(async () => {
      await withScenarioHarness(async (harness) => {
        await options.runScenario(harness);
        events = harness.events();
      });
    }, options.timeoutMs);

    test("captures the scenario root span", testConfig, () => {
      const root = findLatestSpan(events, ROOT_NAME);
      expect(root).toBeDefined();
      expect(root?.row.metadata).toMatchObject({
        scenario: SCENARIO_NAME,
      });
    });

    test("captures chat and stream spans", testConfig, () => {
      const chatOperation = findLatestSpan(events, "groq-chat-operation");
      const chatSpan = findGroqSpan(
        events,
        chatOperation?.span.id,
        "groq.chat.completions.create",
      );
      const streamOperation = findLatestSpan(events, "groq-stream-operation");
      const streamSpan = findGroqSpan(
        events,
        streamOperation?.span.id,
        "groq.chat.completions.create",
      );

      expect(chatSpan?.row.metadata).toMatchObject({
        provider: "groq",
      });
      expect(chatSpan?.row.metadata?.model).toBeDefined();
      expect(chatSpan?.output).toBeDefined();

      expect(streamSpan?.row.metadata).toMatchObject({
        provider: "groq",
      });
      expect(streamSpan?.row.metadata?.model).toBeDefined();
      expect(streamSpan?.output).toBeDefined();
      expect(streamSpan?.metrics).toMatchObject({
        time_to_first_token: expect.any(Number),
      });
    });

    test(
      "captures reasoning content from parsed streaming chunks",
      testConfig,
      () => {
        const operation = findLatestSpan(
          events,
          "groq-reasoning-stream-operation",
        );
        const span = findGroqSpan(
          events,
          operation?.span.id,
          "groq.chat.completions.create",
        );
        const reasoning = span?.output?.[0]?.message?.reasoning;

        expect(span?.row.metadata).toMatchObject({
          model: REASONING_MODEL,
          provider: "groq",
          reasoning_format: "parsed",
        });
        expect(span?.metrics).toMatchObject({
          time_to_first_token: expect.any(Number),
        });
        expect(reasoning).toEqual(expect.any(String));
        expect(reasoning?.length).toBeGreaterThan(0);
      },
    );

    test("captures tool calling span", testConfig, () => {
      const operation = findLatestSpan(events, "groq-tool-operation");
      const span = findGroqSpan(
        events,
        operation?.span.id,
        "groq.chat.completions.create",
      );

      expect(span?.row.metadata).toMatchObject({
        provider: "groq",
      });
      expect(span?.row.metadata?.model).toBeDefined();
      expect(span?.output?.[0]?.message?.tool_calls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            function: expect.objectContaining({
              name: "get_weather",
            }),
          }),
        ]),
      );
    });

    test("captures transcription and translation", testConfig, () => {
      const transcriptionOperation = findLatestSpan(
        events,
        "groq-transcription-operation",
      );
      const transcriptionSpan = findGroqSpan(
        events,
        transcriptionOperation?.span.id,
        "groq.audio.transcriptions.create",
      );
      const translationOperation = findLatestSpan(
        events,
        "groq-translation-operation",
      );
      const translationSpan = findGroqSpan(
        events,
        translationOperation?.span.id,
        "groq.audio.translations.create",
      );

      for (const span of [transcriptionSpan, translationSpan]) {
        expect(span?.row.metadata).toMatchObject({
          provider: "groq",
        });
        expect(span?.input).toMatchObject({
          content: [
            {
              file: {
                file_data: expect.objectContaining({
                  type: "braintrust_attachment",
                }),
                filename: "brooklyn_bridge.wav",
              },
              type: "file",
            },
          ],
        });
        expect(span?.output?.content?.[0]).toMatchObject({
          text: expect.any(String),
          type: "text",
        });
      }
      expect(transcriptionSpan?.row.metadata).toMatchObject({
        model: AUDIO_MODEL,
      });
      expect(translationSpan?.row.metadata).toMatchObject({
        model: TRANSLATION_MODEL,
      });
      expect(transcriptionSpan?.input).toMatchObject({
        operation: "transcribe",
        parameters: {
          format: "verbose_json",
          language: "en",
          timestamp_granularities: ["word", "segment"],
        },
      });
      expect(translationSpan?.input).toMatchObject({
        operation: "translate",
        parameters: { format: "json" },
      });
    });

    test("matches span tree snapshot", testConfig, async () => {
      await matchSpanTreeSnapshot(events, spanSnapshotPath);
    });
  });
}
