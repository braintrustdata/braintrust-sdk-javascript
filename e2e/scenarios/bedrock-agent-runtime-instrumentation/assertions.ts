import { beforeAll, describe, expect, test } from "vitest";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import {
  withScenarioHarness,
  type ScenarioRunContext,
} from "../../helpers/scenario-harness";
import { matchSpanTreeSnapshot } from "../../helpers/span-tree";
import {
  findChildSpans,
  findLatestSpan,
  spanInstrumentationName,
} from "../../helpers/trace-selectors";
import {
  AGENT_OPERATION_NAME,
  INLINE_OPERATION_NAME,
  MODEL,
  RAG_OPERATION_NAME,
  RAG_STREAM_OPERATION_NAME,
  ROOT_NAME,
  SCENARIO_NAME,
} from "./constants.mjs";

type RunScenario = (harness: {
  runNodeScenarioDir: (options: {
    entry: string;
    env: Record<string, string>;
    nodeArgs: string[];
    runContext?: ScenarioRunContext;
    scenarioDir: string;
    timeoutMs: number;
  }) => Promise<unknown>;
  runScenarioDir: (options: {
    entry: string;
    env: Record<string, string>;
    runContext?: ScenarioRunContext;
    scenarioDir: string;
    timeoutMs: number;
  }) => Promise<unknown>;
}) => Promise<void>;

const OPERATIONS = [
  {
    command: "InvokeAgentCommand",
    operationName: AGENT_OPERATION_NAME,
    spanName: "bedrockAgent.invokeAgent",
  },
  {
    command: "InvokeInlineAgentCommand",
    operationName: INLINE_OPERATION_NAME,
    spanName: "bedrockAgent.invokeInlineAgent",
  },
  {
    command: "RetrieveAndGenerateCommand",
    operationName: RAG_OPERATION_NAME,
    spanName: "bedrockAgent.retrieveAndGenerate",
  },
  {
    command: "RetrieveAndGenerateStreamCommand",
    operationName: RAG_STREAM_OPERATION_NAME,
    spanName: "bedrockAgent.retrieveAndGenerateStream",
  },
] as const;

function findInstrumentationSpan(
  events: CapturedLogEvent[],
  operationName: string,
  spanName: string,
) {
  const operation = findLatestSpan(events, operationName);
  return findChildSpans(events, spanName, operation?.span.id).find(
    (span) => span.output !== undefined,
  );
}

function findAgentSpan(events: CapturedLogEvent[]) {
  return findInstrumentationSpan(
    events,
    AGENT_OPERATION_NAME,
    "bedrockAgent.invokeAgent",
  );
}

function spanTreeEvents(events: CapturedLogEvent[]): CapturedLogEvent[] {
  const root = findLatestSpan(events, ROOT_NAME);
  const items: CapturedLogEvent[] = root ? [root] : [];

  for (const definition of OPERATIONS) {
    const operation = findLatestSpan(events, definition.operationName);
    const instrumentationSpan = findInstrumentationSpan(
      events,
      definition.operationName,
      definition.spanName,
    );
    if (operation) {
      items.push(operation);
    }
    if (instrumentationSpan) {
      items.push(instrumentationSpan);
      for (const childName of ["bedrockAgent.modelInvocation", "get_weather"]) {
        for (const child of findChildSpans(
          events,
          childName,
          instrumentationSpan.span.id,
        )) {
          items.push(child);
        }
      }
    }
  }
  return items;
}

export function defineBedrockAgentRuntimeInstrumentationAssertions(options: {
  name: string;
  runScenario: RunScenario;
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

    test("captures all supported Agent Runtime commands", testConfig, () => {
      for (const definition of OPERATIONS) {
        const operation = findLatestSpan(events, definition.operationName);
        const spans = findChildSpans(
          events,
          definition.spanName,
          operation?.span.id,
        );
        expect(spans, definition.command).toHaveLength(1);
        const span = spans[0];
        expect(span, definition.command).toBeDefined();
        expect(span?.span.type).toBe("task");
        expect(spanInstrumentationName(span)).toBe("bedrock-agent-runtime");
        expect(span?.row.metadata).toMatchObject({
          command: definition.command,
          provider: "aws-bedrock",
        });
      }
    });

    test(
      "captures managed and inline agent streaming output",
      testConfig,
      () => {
        const agentSpan = findAgentSpan(events);
        const inlineSpan = findInstrumentationSpan(
          events,
          INLINE_OPERATION_NAME,
          "bedrockAgent.invokeInlineAgent",
        );
        expect(agentSpan?.input).toBe(
          "Use the weather tool and reply with AGENT_OK.",
        );
        expect(agentSpan?.output).toEqual({ text: "AGENT_OK" });
        expect(inlineSpan?.input).toBe("Reply with exactly INLINE_OK.");
        expect(inlineSpan?.row.metadata).toMatchObject({
          model: MODEL,
        });
        expect(inlineSpan?.output).toEqual({ text: "INLINE_OK" });
        for (const span of [agentSpan, inlineSpan]) {
          expect(span?.metrics).toMatchObject({
            completion_tokens: 4,
            prompt_tokens: 12,
            time_to_first_token: expect.any(Number),
            tokens: 16,
          });
        }
      },
    );

    test("captures model and action-group child spans", testConfig, () => {
      const agentSpan = findAgentSpan(events);
      const modelSpan = findChildSpans(
        events,
        "bedrockAgent.modelInvocation",
        agentSpan?.span.id,
      ).find((span) => span.output !== undefined);
      const toolSpan = findChildSpans(
        events,
        "get_weather",
        agentSpan?.span.id,
      ).find((span) => span.output !== undefined);

      expect(modelSpan).toMatchObject({
        metrics: {
          completion_tokens: 4,
          prompt_tokens: 12,
          tokens: 16,
        },
        span: { type: "llm" },
      });
      expect(modelSpan?.row.metadata).toMatchObject({
        model: MODEL,
        provider: "aws-bedrock",
      });
      expect(spanInstrumentationName(modelSpan)).toBe("bedrock-agent-runtime");
      expect(toolSpan).toMatchObject({
        input: {
          parameters: [{ name: "city", value: "Paris" }],
        },
        output: {
          text: JSON.stringify({ temperature: 18 }),
        },
        span: { type: "tool" },
      });
      expect(toolSpan?.row.metadata).toMatchObject({
        action_group: "weather",
        provider: "aws-bedrock",
        tool_type: "action_group",
      });
      expect(spanInstrumentationName(toolSpan)).toBe("bedrock-agent-runtime");
    });

    test("captures non-streaming and streaming RAG results", testConfig, () => {
      const ragSpan = findInstrumentationSpan(
        events,
        RAG_OPERATION_NAME,
        "bedrockAgent.retrieveAndGenerate",
      );
      const ragStreamSpan = findInstrumentationSpan(
        events,
        RAG_STREAM_OPERATION_NAME,
        "bedrockAgent.retrieveAndGenerateStream",
      );

      expect(ragSpan?.input).toEqual({
        text: "Return the deterministic RAG answer.",
      });
      expect(ragSpan?.output).toMatchObject({
        citations: expect.any(Array),
        text: "RAG_OK",
      });
      expect(ragSpan?.row.metadata).toMatchObject({
        knowledgeBaseId: "kb-1",
        model: expect.stringContaining(MODEL),
      });
      expect(ragStreamSpan?.output).toMatchObject({
        citations: expect.any(Array),
        text: "STREAM_RAG_OK",
      });
      expect(ragStreamSpan?.row.metadata).toMatchObject({
        guardrailAction: "NONE",
      });
      expect(ragStreamSpan?.metrics).toMatchObject({
        time_to_first_token: expect.any(Number),
      });
    });

    test("matches span tree snapshot", testConfig, async () => {
      await matchSpanTreeSnapshot(spanTreeEvents(events), spanSnapshotPath);
    });
  });
}
