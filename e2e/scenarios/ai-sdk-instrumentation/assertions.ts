import { beforeAll, describe, expect, test } from "vitest";
import { normalizeForSnapshot, type Json } from "../../helpers/normalize";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import {
  formatJsonFileSnapshot,
  resolveFileSnapshotPath,
} from "../../helpers/file-snapshot";
import { withScenarioHarness } from "../../helpers/scenario-harness";
import {
  findAllSpans,
  findChildSpans,
  findLatestSpan,
} from "../../helpers/trace-selectors";

import { ROOT_NAME, SCENARIO_NAME } from "./scenario.impl.mjs";

type AgentSpanName = "Agent" | "ToolLoopAgent";

type RunAISDKScenario = (harness: {
  runNodeScenarioDir: (options: {
    entry: string;
    nodeArgs: string[];
    scenarioDir: string;
    timeoutMs: number;
  }) => Promise<unknown>;
  runScenarioDir: (options: {
    entry: string;
    scenarioDir: string;
    timeoutMs: number;
  }) => Promise<unknown>;
}) => Promise<void>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function latestEvent<T>(events: T[]): T | undefined {
  return events.at(-1);
}

function pickMetadata(
  metadata: Record<string, unknown> | undefined,
  keys: string[],
): Json {
  if (!metadata) {
    return null;
  }

  const picked = Object.fromEntries(
    keys.flatMap((key) =>
      key in metadata
        ? [
            [
              key,
              key === "aiSdkVersion"
                ? "<ai-sdk-version>"
                : (metadata[key] as Json),
            ],
          ]
        : [],
    ),
  );

  return Object.keys(picked).length > 0 ? (picked as Json) : null;
}

function collectToolCallNames(output: unknown): string[] {
  if (!isRecord(output)) {
    return [];
  }

  const steps = Array.isArray(output.steps) ? output.steps : [];
  const toolCalls = Array.isArray(output.toolCalls) ? output.toolCalls : [];
  const names = [...toolCalls, ...steps.flatMap((step) => step.toolCalls ?? [])]
    .map((call) => (isRecord(call) ? (call.toolName ?? call.name) : undefined))
    .filter((name): name is string => typeof name === "string");

  return [...new Set(names)];
}

function summarizePrompt(value: unknown): Json {
  if (typeof value === "string") {
    return "<prompt>";
  }

  if (!Array.isArray(value)) {
    return null;
  }

  return value.map((message) => {
    if (!isRecord(message)) {
      return "<message>" as Json;
    }

    const summary: Record<string, Json> = {
      role: typeof message.role === "string" ? message.role : "<message>",
    };

    if (Array.isArray(message.content)) {
      summary.content_types = message.content
        .map((entry) => (isRecord(entry) ? entry.type : undefined))
        .filter((type): type is string => typeof type === "string");
    }

    return summary as Json;
  });
}

function summarizeSchema(value: unknown): Json {
  return value === undefined ? null : "<schema>";
}

function findModelChildren(
  capturedEvents: CapturedLogEvent[],
  parentId: string | undefined,
) {
  return capturedEvents.filter((event) => {
    const name = event.span.name ?? "";
    return (
      event.span.parentIds[0] === parentId &&
      (name === "doGenerate" || name === "doStream")
    );
  });
}

function findParentSpan(
  events: CapturedLogEvent[],
  name: string,
  parentId: string | undefined,
) {
  return findChildSpans(events, name, parentId)[0];
}

function findLatestModelSpan(
  events: CapturedLogEvent[],
  parentId: string | undefined,
  name: "doGenerate" | "doStream",
) {
  return latestEvent(findChildSpans(events, name, parentId));
}

function findGenerateTrace(events: CapturedLogEvent[]) {
  const operation = findLatestSpan(events, "ai-sdk-generate-operation");
  const parent = findParentSpan(events, "generateText", operation?.span.id);
  const child = findLatestModelSpan(events, parent?.span.id, "doGenerate");

  return { child, operation, parent };
}

function findStreamTrace(events: CapturedLogEvent[]) {
  const operation = findLatestSpan(events, "ai-sdk-stream-operation");
  const parent = findParentSpan(events, "streamText", operation?.span.id);
  const child = findLatestModelSpan(events, parent?.span.id, "doStream");

  return { child, operation, parent };
}

function findToolTrace(events: CapturedLogEvent[]) {
  const operation = findLatestSpan(events, "ai-sdk-tool-operation");
  const parent = findParentSpan(events, "generateText", operation?.span.id);
  const toolSpans = findAllSpans(events, "get_weather").filter(
    (event) => event.span.rootId === operation?.span.rootId,
  );
  const modelChildren = events
    .filter((event) => event.span.rootId === operation?.span.rootId)
    .filter((event) => {
      const name = event.span.name ?? "";
      return name === "doGenerate" || name === "doStream";
    })
    .filter((event) => event.span.parentIds[0] !== parent?.span.id);

  return {
    modelChildren,
    operation,
    parent,
    toolSpans,
  };
}

function findGenerateObjectTrace(events: CapturedLogEvent[]) {
  const operation = findLatestSpan(events, "ai-sdk-generate-object-operation");
  const parent = findParentSpan(events, "generateObject", operation?.span.id);
  const child = findLatestModelSpan(events, parent?.span.id, "doGenerate");

  return { child, operation, parent };
}

function findStreamObjectTrace(events: CapturedLogEvent[]) {
  const operation = findLatestSpan(events, "ai-sdk-stream-object-operation");
  const parent = findParentSpan(events, "streamObject", operation?.span.id);
  const child = findLatestModelSpan(events, parent?.span.id, "doStream");

  return { child, operation, parent };
}

function findAgentGenerateTrace(
  events: CapturedLogEvent[],
  agentSpanName: AgentSpanName,
) {
  const operation = findLatestSpan(events, "ai-sdk-agent-generate-operation");
  const parent = findParentSpan(
    events,
    `${agentSpanName}.generate`,
    operation?.span.id,
  );
  const modelChildren = findModelChildren(events, parent?.span.id);

  return {
    latestChild: latestEvent(modelChildren),
    modelChildren,
    operation,
    parent,
  };
}

function findAgentStreamTrace(
  events: CapturedLogEvent[],
  agentSpanName: AgentSpanName,
) {
  const operation = findLatestSpan(events, "ai-sdk-agent-stream-operation");
  const parent = findParentSpan(
    events,
    `${agentSpanName}.stream`,
    operation?.span.id,
  );
  const modelChildren = findModelChildren(events, parent?.span.id);

  return {
    latestChild: latestEvent(modelChildren),
    modelChildren,
    operation,
    parent,
  };
}

function normalizeAISDKContext(value: unknown): Json {
  const context = isRecord(value) ? value : {};
  return {
    ...Object.fromEntries(
      Object.entries(context).filter(([key]) => !key.startsWith("caller_")),
    ),
    caller_filename: "<caller>",
    caller_functionname: "<caller>",
    caller_lineno: 0,
  } satisfies Json;
}

function normalizeAISDKSnapshotValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeAISDKSnapshotValue(entry));
  }

  if (!isRecord(value)) {
    return value;
  }

  const normalized: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(value)) {
    if (key === "context") {
      normalized[key] = normalizeAISDKContext(entry);
      continue;
    }

    if (key === "aiSdkVersion") {
      normalized[key] = "<ai-sdk-version>";
      continue;
    }

    if (
      (key === "completionTokens" ||
        key === "completion_tokens" ||
        key === "inputTokens" ||
        key === "outputTokens" ||
        key === "prompt_tokens" ||
        key === "promptTokens" ||
        key === "reasoningTokens" ||
        key === "textTokens" ||
        key === "tokens" ||
        key === "totalTokens") &&
      typeof entry === "number"
    ) {
      normalized[key] = 0;
      continue;
    }

    if (key === "estimated_cost" && typeof entry === "number") {
      normalized[key] = 0;
      continue;
    }

    if ((key === "_output" || key === "text") && typeof entry === "string") {
      normalized[key] = "<llm-response>";
      continue;
    }

    if (
      key === "user-agent" &&
      typeof entry === "string" &&
      entry.startsWith("ai/")
    ) {
      normalized[key] = "ai/<version>";
      continue;
    }

    if (key === "stepNumber") {
      continue;
    }

    if (
      key === "model" &&
      isRecord(entry) &&
      typeof entry.modelId === "string" &&
      typeof entry.provider === "string"
    ) {
      continue;
    }

    normalized[key] = normalizeAISDKSnapshotValue(entry);
  }

  return normalized;
}

function snapshotValue(value: unknown): Json {
  if (value === undefined) {
    return null;
  }

  return normalizeAISDKSnapshotValue(structuredClone(value)) as Json;
}

function summarizeAISDKSpan(event: CapturedLogEvent): Json {
  return {
    has_input: event.input !== undefined && event.input !== null,
    has_output: event.output !== undefined && event.output !== null,
    metadata: pickMetadata(
      event.row.metadata as Record<string, unknown> | undefined,
      ["aiSdkVersion", "provider", "model", "operation", "scenario"],
    ),
    name: event.span.name ?? null,
    root_span_id: event.span.rootId ?? null,
    span_id: event.span.id ?? null,
    span_parents: event.span.parentIds,
  } satisfies Json;
}

function summarizeAISDKInput(value: unknown): Json {
  if (!isRecord(value)) {
    return snapshotValue(value);
  }

  const summary: Record<string, Json> = {};
  const prompt = summarizePrompt(value.prompt ?? value.messages);

  if (prompt !== null) {
    summary.prompt = prompt;
  }
  if (value.schema !== undefined) {
    summary.schema = summarizeSchema(value.schema);
  }

  return Object.keys(summary).length > 0
    ? (summary as Json)
    : snapshotValue(value);
}

function summarizeAISDKOutput(name: string | null, value: unknown): Json {
  if (name === "get_weather") {
    return snapshotValue(value);
  }

  if (!isRecord(value)) {
    return value === undefined ? null : ({} as Json);
  }

  return {};
}

function summarizeAISDKPayload(event: CapturedLogEvent): Json {
  return {
    input: summarizeAISDKInput(event.input),
    metadata: pickMetadata(
      event.row.metadata as Record<string, unknown> | undefined,
      ["aiSdkVersion", "provider", "model", "operation", "scenario"],
    ),
    name: event.span.name ?? null,
    output: summarizeAISDKOutput(event.span.name ?? null, event.output),
  } satisfies Json;
}

function collectSummaryEvents(
  events: CapturedLogEvent[],
  options: {
    agentSpanName?: AgentSpanName;
    supportsGenerateObject: boolean;
    supportsStreamObject: boolean;
  },
) {
  const generate = findGenerateTrace(events);
  const stream = findStreamTrace(events);
  const tool = findToolTrace(events);
  const generateObject = options.supportsGenerateObject
    ? findGenerateObjectTrace(events)
    : undefined;
  const streamObject = options.supportsStreamObject
    ? findStreamObjectTrace(events)
    : undefined;
  const agentGenerate = options.agentSpanName
    ? findAgentGenerateTrace(events, options.agentSpanName)
    : undefined;
  const agentStream = options.agentSpanName
    ? findAgentStreamTrace(events, options.agentSpanName)
    : undefined;

  return [
    findLatestSpan(events, ROOT_NAME),
    generate.operation,
    generate.parent,
    stream.operation,
    stream.parent,
    tool.operation,
    tool.parent,
    ...tool.toolSpans,
    ...(generateObject
      ? [generateObject.operation, generateObject.parent]
      : []),
    ...(streamObject ? [streamObject.operation, streamObject.parent] : []),
    ...(agentGenerate ? [agentGenerate.operation, agentGenerate.parent] : []),
    ...(agentStream ? [agentStream.operation, agentStream.parent] : []),
  ].filter((event): event is CapturedLogEvent => event !== undefined);
}

function buildSpanSummary(
  events: CapturedLogEvent[],
  options: {
    agentSpanName?: AgentSpanName;
    supportsGenerateObject: boolean;
    supportsStreamObject: boolean;
  },
): Json {
  return normalizeForSnapshot(
    collectSummaryEvents(events, options).map((event) =>
      summarizeAISDKSpan(event),
    ),
  );
}

function buildPayloadSummary(
  events: CapturedLogEvent[],
  options: {
    agentSpanName?: AgentSpanName;
    supportsGenerateObject: boolean;
    supportsStreamObject: boolean;
  },
): Json {
  return normalizeForSnapshot(
    collectSummaryEvents(events, options).map((event) =>
      summarizeAISDKPayload(event),
    ),
  );
}

function expectOperationParentedByRoot(
  operation: CapturedLogEvent | undefined,
  root: CapturedLogEvent | undefined,
) {
  expect(operation).toBeDefined();
  expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);
}

function expectAISDKParentSpan(span: CapturedLogEvent | undefined) {
  expect(span).toBeDefined();
  expect(span?.row.metadata).toMatchObject({
    braintrust: {
      integration_name: "ai-sdk",
      sdk_language: "typescript",
    },
  });
  expect(
    String(
      (span?.row.metadata as { provider?: unknown } | undefined)?.provider ??
        "",
    ).startsWith("openai"),
  ).toBe(true);
  expect(
    typeof (span?.row.metadata as { model?: unknown } | undefined)?.model,
  ).toBe("string");
}

export function defineAISDKInstrumentationAssertions(options: {
  agentSpanName?: AgentSpanName;
  name: string;
  runScenario: RunAISDKScenario;
  snapshotName: string;
  supportsGenerateObject: boolean;
  supportsStreamObject: boolean;
  supportsToolExecution: boolean;
  testFileUrl: string;
  timeoutMs: number;
}): void {
  const spanSnapshotPath = resolveFileSnapshotPath(
    options.testFileUrl,
    `${options.snapshotName}.span-events.json`,
  );
  const payloadSnapshotPath = resolveFileSnapshotPath(
    options.testFileUrl,
    `${options.snapshotName}.log-payloads.json`,
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

    test("captures the root trace for the scenario", testConfig, () => {
      const root = findLatestSpan(events, ROOT_NAME);

      expect(root).toBeDefined();
      expect(root?.row.metadata).toMatchObject({
        scenario: SCENARIO_NAME,
      });
      expect(
        typeof (root?.row.metadata as { aiSdkVersion?: unknown } | undefined)
          ?.aiSdkVersion,
      ).toBe("string");
    });

    test("captures trace for generateText()", testConfig, () => {
      const root = findLatestSpan(events, ROOT_NAME);
      const trace = findGenerateTrace(events);

      expectOperationParentedByRoot(trace.operation, root);
      expectAISDKParentSpan(trace.parent);
      expect(trace.child).toBeDefined();
      expect(trace.child?.metrics).toMatchObject({
        completion_tokens: expect.any(Number),
        prompt_tokens: expect.any(Number),
      });
    });

    test("captures trace for streamText()", testConfig, () => {
      const root = findLatestSpan(events, ROOT_NAME);
      const trace = findStreamTrace(events);

      expectOperationParentedByRoot(trace.operation, root);
      expectAISDKParentSpan(trace.parent);
      expect(trace.parent?.metrics?.time_to_first_token).toEqual(
        expect.any(Number),
      );
      expect(trace.child?.output).toBeDefined();
      expect(trace.child?.metrics).toMatchObject({
        completion_tokens: expect.any(Number),
        prompt_tokens: expect.any(Number),
      });
    });

    test("captures trace for generateText() with tools", testConfig, () => {
      const root = findLatestSpan(events, ROOT_NAME);
      const trace = findToolTrace(events);

      expectOperationParentedByRoot(trace.operation, root);
      expectAISDKParentSpan(trace.parent);
      expect(trace.parent?.input).toBeDefined();
      expect(trace.parent?.output).toBeDefined();

      if (options.supportsToolExecution) {
        expect(trace.modelChildren.length).toBeGreaterThanOrEqual(2);
        expect(trace.toolSpans.length).toBeGreaterThanOrEqual(1);
        expect(trace.toolSpans[0]?.input).toBeDefined();
        expect(trace.toolSpans[0]?.output).toBeDefined();
      } else {
        expect(trace.modelChildren.length).toBeGreaterThanOrEqual(1);
        expect(collectToolCallNames(trace.parent?.output)).toContain(
          "get_weather",
        );
      }
    });

    if (options.supportsGenerateObject) {
      test("captures trace for generateObject()", testConfig, () => {
        const root = findLatestSpan(events, ROOT_NAME);
        const trace = findGenerateObjectTrace(events);

        expectOperationParentedByRoot(trace.operation, root);
        expectAISDKParentSpan(trace.parent);
        expect(trace.parent?.output).toMatchObject({
          object: { city: "Paris" },
        });
        if (trace.child) {
          expect(trace.child.output).toBeDefined();
        }
      });
    }

    if (options.supportsStreamObject) {
      test("captures trace for streamObject()", testConfig, () => {
        const root = findLatestSpan(events, ROOT_NAME);
        const trace = findStreamObjectTrace(events);

        expectOperationParentedByRoot(trace.operation, root);
        expectAISDKParentSpan(trace.parent);
        if (trace.parent?.metrics?.time_to_first_token !== undefined) {
          expect(trace.parent.metrics.time_to_first_token).toEqual(
            expect.any(Number),
          );
        }
        if (
          (trace.parent?.output as { object?: unknown } | undefined)?.object !==
          undefined
        ) {
          expect(trace.parent?.output).toMatchObject({
            object: { city: "Paris" },
          });
        } else {
          expect(trace.parent?.output).toBeDefined();
        }
        if (trace.child) {
          expect(trace.child.output).toBeDefined();
        }
      });
    }

    if (options.agentSpanName) {
      test("captures trace for agent.generate()", testConfig, () => {
        const root = findLatestSpan(events, ROOT_NAME);
        const trace = findAgentGenerateTrace(events, options.agentSpanName!);

        expectOperationParentedByRoot(trace.operation, root);
        expectAISDKParentSpan(trace.parent);
        expect(trace.parent?.output).toBeDefined();
        expect(trace.modelChildren.length).toBeGreaterThanOrEqual(1);
        expect(trace.latestChild?.output).toBeDefined();
      });

      test("captures trace for agent.stream()", testConfig, () => {
        const root = findLatestSpan(events, ROOT_NAME);
        const trace = findAgentStreamTrace(events, options.agentSpanName!);

        expectOperationParentedByRoot(trace.operation, root);
        expectAISDKParentSpan(trace.parent);
        expect(trace.parent?.metrics?.time_to_first_token).toEqual(
          expect.any(Number),
        );
        expect(trace.modelChildren.length).toBeGreaterThanOrEqual(1);
        expect(trace.latestChild?.output).toBeDefined();
      });
    }

    test("matches the shared span snapshot", testConfig, async () => {
      await expect(
        formatJsonFileSnapshot(
          buildSpanSummary(events, {
            agentSpanName: options.agentSpanName,
            supportsGenerateObject: options.supportsGenerateObject,
            supportsStreamObject: options.supportsStreamObject,
          }),
        ),
      ).toMatchFileSnapshot(spanSnapshotPath);
    });

    test("matches the shared payload snapshot", testConfig, async () => {
      await expect(
        formatJsonFileSnapshot(
          buildPayloadSummary(events, {
            agentSpanName: options.agentSpanName,
            supportsGenerateObject: options.supportsGenerateObject,
            supportsStreamObject: options.supportsStreamObject,
          }),
        ),
      ).toMatchFileSnapshot(payloadSnapshotPath);
    });
  });
}
