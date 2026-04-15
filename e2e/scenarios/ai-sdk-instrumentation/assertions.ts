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
    runContext?: { variantKey: string };
    scenarioDir: string;
    timeoutMs: number;
  }) => Promise<unknown>;
  runScenarioDir: (options: {
    entry: string;
    runContext?: { variantKey: string };
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

function pickMetrics(
  metrics: Record<string, unknown> | undefined,
  keys: string[],
): Json {
  if (!metrics) {
    return null;
  }

  const picked = Object.fromEntries(
    keys.flatMap((key) =>
      key in metrics ? [[key, metrics[key] as Json]] : [],
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

function collectToolResultNames(output: unknown): string[] {
  if (!isRecord(output)) {
    return [];
  }

  const steps = Array.isArray(output.steps) ? output.steps : [];
  const toolResults = Array.isArray(output.toolResults)
    ? output.toolResults
    : [];
  const names = [
    ...toolResults,
    ...steps.flatMap((step) =>
      isRecord(step)
        ? [
            ...(Array.isArray(step.toolResults) ? step.toolResults : []),
            ...(Array.isArray(step.content) ? step.content : []),
          ]
        : [],
    ),
  ]
    .map((result) =>
      isRecord(result) ? (result.toolName ?? result.name) : undefined,
    )
    .filter((name): name is string => typeof name === "string");

  return [...new Set(names)];
}

function collectMetricValues(
  events: CapturedLogEvent[],
  key: string,
): number[] {
  return events
    .map((event) => event.metrics?.[key])
    .filter((value): value is number => typeof value === "number");
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

function findGenerateTextTraceForOperation(
  events: CapturedLogEvent[],
  operationSpanName: string,
) {
  const operation = findLatestSpan(events, operationSpanName);
  const parents = findChildSpans(events, "generateText", operation?.span.id);
  const parent = latestEvent(parents);
  const modelChildren = parents.flatMap((candidate) =>
    findChildSpans(events, "doGenerate", candidate.span.id),
  );

  return {
    latestChild: latestEvent(modelChildren),
    modelChildren,
    operation,
    parent,
    parents,
  };
}

function findOpenAICacheTrace(events: CapturedLogEvent[]) {
  return findGenerateTextTraceForOperation(
    events,
    "ai-sdk-openai-cache-operation",
  );
}

function findAnthropicCacheTrace(events: CapturedLogEvent[]) {
  return findGenerateTextTraceForOperation(
    events,
    "ai-sdk-anthropic-cache-operation",
  );
}

function findOutputObjectTrace(events: CapturedLogEvent[]) {
  return findGenerateTextTraceForOperation(
    events,
    "ai-sdk-output-object-operation",
  );
}

function findAttachmentTrace(events: CapturedLogEvent[]) {
  return findGenerateTextTraceForOperation(
    events,
    "ai-sdk-attachment-operation",
  );
}

function findDenyOutputOverrideTrace(events: CapturedLogEvent[]) {
  return findGenerateTextTraceForOperation(
    events,
    "ai-sdk-deny-output-override-operation",
  );
}

function findStreamTrace(events: CapturedLogEvent[]) {
  const operation = findLatestSpan(events, "ai-sdk-stream-operation");
  const parent = findParentSpan(events, "streamText", operation?.span.id);
  const child = findLatestModelSpan(events, parent?.span.id, "doStream");

  return { child, operation, parent };
}

function findEmbedTrace(events: CapturedLogEvent[]) {
  const operation = findLatestSpan(events, "ai-sdk-embed-operation");
  const parent = findParentSpan(events, "embed", operation?.span.id);

  return { operation, parent };
}

function findEmbedManyTrace(events: CapturedLogEvent[]) {
  const operation = findLatestSpan(events, "ai-sdk-embed-many-operation");
  const parent = findParentSpan(events, "embedMany", operation?.span.id);

  return { operation, parent };
}

function findRerankTrace(events: CapturedLogEvent[]) {
  const operation = findLatestSpan(events, "ai-sdk-rerank-operation");
  const parent = findParentSpan(events, "rerank", operation?.span.id);

  return { operation, parent };
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

function operationName(
  event: CapturedLogEvent | undefined,
): string | undefined {
  const metadata = event?.row.metadata;
  if (!isRecord(metadata)) {
    return undefined;
  }

  return typeof metadata.operation === "string"
    ? metadata.operation
    : undefined;
}

function hasPromptLikeInput(input: unknown): boolean {
  if (!isRecord(input)) {
    return false;
  }

  return input.prompt !== undefined || input.messages !== undefined;
}

function hasSemanticOutput(
  output: unknown,
  keys: string[],
  allowNonEmptyString = true,
): boolean {
  if (allowNonEmptyString && typeof output === "string") {
    return output.length > 0;
  }

  if (!isRecord(output)) {
    return false;
  }

  return keys.some((key) => key in output);
}

function toolNamesFromInput(input: unknown): string[] {
  if (!isRecord(input)) {
    return [];
  }

  const tools = input.tools;
  if (isRecord(tools)) {
    return Object.keys(tools);
  }

  if (!Array.isArray(tools)) {
    return [];
  }

  return tools
    .map((tool) => {
      if (!isRecord(tool)) {
        return undefined;
      }

      const maybeName = tool.name ?? tool.toolName;
      return typeof maybeName === "string" ? maybeName : undefined;
    })
    .filter((name): name is string => typeof name === "string");
}

function extractOutputRecord(
  event: CapturedLogEvent | undefined,
): Record<string, unknown> | undefined {
  return isRecord(event?.output) ? event.output : undefined;
}

function extractFinishReason(
  event: CapturedLogEvent | undefined,
): string | undefined {
  const output = extractOutputRecord(event);
  const outputFinishReason = output?.finishReason;
  if (typeof outputFinishReason === "string") {
    return outputFinishReason;
  }

  const metadata = event?.row.metadata;
  if (!isRecord(metadata)) {
    return undefined;
  }

  return typeof metadata.finish_reason === "string"
    ? metadata.finish_reason
    : undefined;
}

function extractFileAttachmentReference(
  input: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(input) || !Array.isArray(input.messages)) {
    return undefined;
  }

  for (const message of input.messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) {
      continue;
    }

    for (const part of message.content) {
      if (!isRecord(part) || part.type !== "file") {
        continue;
      }

      const data = part.data;
      if (isRecord(data) && isRecord(data.reference)) {
        return data.reference;
      }

      if (isRecord(data) && data.type === "braintrust_attachment") {
        return data;
      }
    }
  }

  return undefined;
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
    metrics: pickMetrics(event.metrics, [
      "completion_tokens",
      "prompt_tokens",
      "prompt_cached_tokens",
      "prompt_cache_creation_tokens",
      "time_to_first_token",
      "tokens",
    ]),
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
    metrics: pickMetrics(event.metrics, [
      "completion_tokens",
      "prompt_tokens",
      "prompt_cached_tokens",
      "prompt_cache_creation_tokens",
      "time_to_first_token",
      "tokens",
    ]),
    name: event.span.name ?? null,
    output: summarizeAISDKOutput(event.span.name ?? null, event.output),
  } satisfies Json;
}

function collectSummaryEvents(
  events: CapturedLogEvent[],
  options: {
    agentSpanName?: AgentSpanName;
    sdkMajorVersion: number;
    supportsProviderCacheAssertions: boolean;
    supportsGenerateObject: boolean;
    supportsRerank: boolean;
    supportsStreamObject: boolean;
  },
) {
  const generate = findGenerateTrace(events);
  const stream = findStreamTrace(events);
  const tool = findToolTrace(events);
  const rerank = options.supportsRerank ? findRerankTrace(events) : undefined;
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
    ...(rerank ? [rerank.operation, rerank.parent] : []),
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
    sdkMajorVersion: number;
    supportsProviderCacheAssertions: boolean;
    supportsGenerateObject: boolean;
    supportsRerank: boolean;
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
    sdkMajorVersion: number;
    supportsProviderCacheAssertions: boolean;
    supportsGenerateObject: boolean;
    supportsRerank: boolean;
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

function expectAISDKParentSpan(
  span: CapturedLogEvent | undefined,
  providerPrefix = "openai",
) {
  expect(span).toBeDefined();
  expect(span?.span.type).toBe("function");
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
    ).startsWith(providerPrefix),
  ).toBe(true);
  expect(
    typeof (span?.row.metadata as { model?: unknown } | undefined)?.model,
  ).toBe("string");
}

function expectAISDKModelChildSpan(span: CapturedLogEvent | undefined) {
  expect(span).toBeDefined();
  expect(span?.span.type).toBe("llm");
  expect(["doGenerate", "doStream"]).toContain(span?.span.name);
}

function expectEmbeddingTokenMetrics(span: CapturedLogEvent | undefined) {
  const metrics = span?.metrics as Record<string, unknown> | undefined;
  const totalTokens = metrics?.tokens;
  const promptTokens = metrics?.prompt_tokens;

  const tokenMetric =
    typeof totalTokens === "number"
      ? totalTokens
      : typeof promptTokens === "number"
        ? promptTokens
        : undefined;

  expect(tokenMetric).toEqual(expect.any(Number));
  if (typeof tokenMetric === "number") {
    expect(tokenMetric).toBeGreaterThan(0);
  }
}

function expectMetricGreaterThanZero(
  span: CapturedLogEvent | undefined,
  key: string,
) {
  const metric = span?.metrics?.[key];

  expect(metric).toEqual(expect.any(Number));
  if (typeof metric === "number") {
    expect(metric).toBeGreaterThan(0);
  }
}

function expectAnyMetricGreaterThanZero(
  events: CapturedLogEvent[],
  key: string,
) {
  const metrics = collectMetricValues(events, key);

  expect(metrics).not.toHaveLength(0);
  expect(metrics.some((metric) => metric > 0)).toBe(true);
}

export function defineAISDKInstrumentationAssertions(options: {
  agentSpanName?: AgentSpanName;
  name: string;
  runScenario: RunAISDKScenario;
  sdkMajorVersion: number;
  snapshotName: string;
  supportsAttachmentScenario: boolean;
  supportsProviderCacheAssertions: boolean;
  supportsDenyOutputOverrideScenario: boolean;
  supportsGenerateObject: boolean;
  supportsOutputObjectScenario: boolean;
  supportsRerank: boolean;
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
      expectAISDKModelChildSpan(trace.child);
      expect(trace.child?.metrics).toMatchObject({
        completion_tokens: expect.any(Number),
        prompt_tokens: expect.any(Number),
      });
      expect(trace.parent?.metrics?.completion_tokens).toBeUndefined();
      expect(trace.parent?.metrics?.prompt_tokens).toBeUndefined();
      expect(trace.parent?.metrics?.tokens).toBeUndefined();
      expect(operationName(trace.operation)).toBe("generate");
      expect(hasPromptLikeInput(trace.parent?.input)).toBe(true);
      expect(
        hasSemanticOutput(trace.parent?.output, [
          "_output",
          "text",
          "steps",
          "toolCalls",
        ]),
      ).toBe(true);
    });

    if (options.sdkMajorVersion >= 5) {
      test(
        "captures cache metrics for OpenAI generateText()",
        testConfig,
        () => {
          const root = findLatestSpan(events, ROOT_NAME);
          const trace = findOpenAICacheTrace(events);

          expectOperationParentedByRoot(trace.operation, root);
          expect(trace.parents.length).toBeGreaterThanOrEqual(2);
          trace.parents.forEach((parent) => expectAISDKParentSpan(parent));
          expect(trace.modelChildren.length).toBeGreaterThanOrEqual(2);
          trace.modelChildren.forEach(expectAISDKModelChildSpan);
          expectAnyMetricGreaterThanZero(
            trace.modelChildren,
            "prompt_cached_tokens",
          );
        },
      );
    }

    if (options.supportsProviderCacheAssertions) {
      test(
        "captures cache metrics for Anthropic generateText()",
        testConfig,
        () => {
          const root = findLatestSpan(events, ROOT_NAME);
          const trace = findAnthropicCacheTrace(events);

          expectOperationParentedByRoot(trace.operation, root);
          expect(trace.parents.length).toBeGreaterThanOrEqual(2);
          trace.parents.forEach((parent) =>
            expectAISDKParentSpan(parent, "anthropic"),
          );
          expect(trace.modelChildren.length).toBeGreaterThanOrEqual(2);
          trace.modelChildren.forEach(expectAISDKModelChildSpan);
          expectAnyMetricGreaterThanZero(
            trace.modelChildren,
            "prompt_cached_tokens",
          );
          expect(
            collectMetricValues(
              trace.modelChildren,
              "prompt_cache_creation_tokens",
            ),
          ).not.toHaveLength(0);
        },
      );
    }

    test("captures trace for streamText()", testConfig, () => {
      const root = findLatestSpan(events, ROOT_NAME);
      const trace = findStreamTrace(events);

      expectOperationParentedByRoot(trace.operation, root);
      expectAISDKParentSpan(trace.parent);
      expectAISDKModelChildSpan(trace.child);
      expect(trace.parent?.metrics?.time_to_first_token).toEqual(
        expect.any(Number),
      );
      expect(trace.child?.output).toBeDefined();
      expect(trace.child?.metrics).toMatchObject({
        completion_tokens: expect.any(Number),
        prompt_tokens: expect.any(Number),
      });
      expect(trace.parent?.metrics?.completion_tokens).toBeUndefined();
      expect(trace.parent?.metrics?.prompt_tokens).toBeUndefined();
      expect(trace.parent?.metrics?.tokens).toBeUndefined();
      expect(operationName(trace.operation)).toBe("stream");
      expect(hasPromptLikeInput(trace.parent?.input)).toBe(true);
      expect(
        hasSemanticOutput(trace.parent?.output, [
          "_output",
          "text",
          "steps",
          "toolCalls",
        ]),
      ).toBe(true);
      expect(extractFinishReason(trace.parent)).toEqual(expect.any(String));
      const output = extractOutputRecord(trace.parent);
      expect(output).toBeDefined();
      if (output) {
        const finalText = output.text ?? output._output;
        expect(typeof finalText).toBe("string");
        expect(String(finalText).length).toBeGreaterThan(0);
      }
    });

    test("captures trace for embed()", testConfig, () => {
      const root = findLatestSpan(events, ROOT_NAME);
      const trace = findEmbedTrace(events);

      expectOperationParentedByRoot(trace.operation, root);
      expectAISDKParentSpan(trace.parent);
      expect(operationName(trace.operation)).toBe("embed");
      expectEmbeddingTokenMetrics(trace.parent);
      const input = isRecord(trace.parent?.input) ? trace.parent.input : null;
      expect(typeof input?.value).toBe("string");
      const output = extractOutputRecord(trace.parent);
      expect(output).toBeDefined();
      if (output) {
        expect(output.embedding).toBeUndefined();
        expect(output.embedding_length).toEqual(expect.any(Number));
        expect(output.embedding_length).toBeGreaterThan(0);
      }
    });

    test("captures trace for embedMany()", testConfig, () => {
      const root = findLatestSpan(events, ROOT_NAME);
      const trace = findEmbedManyTrace(events);

      expectOperationParentedByRoot(trace.operation, root);
      expectAISDKParentSpan(trace.parent);
      expect(operationName(trace.operation)).toBe("embed-many");
      expectEmbeddingTokenMetrics(trace.parent);
      const input = isRecord(trace.parent?.input) ? trace.parent.input : null;
      expect(Array.isArray(input?.values)).toBe(true);
      if (Array.isArray(input?.values)) {
        expect(input.values.length).toBeGreaterThanOrEqual(2);
      }
      const output = extractOutputRecord(trace.parent);
      expect(output).toBeDefined();
      if (output) {
        expect(output.embeddings).toBeUndefined();
        expect(output.responses).toBeUndefined();
        expect(output.embedding_count).toEqual(expect.any(Number));
        expect(output.embedding_count).toBeGreaterThanOrEqual(2);
        expect(output.embedding_length).toEqual(expect.any(Number));
        expect(output.embedding_length).toBeGreaterThan(0);
      }
    });

    if (options.supportsRerank) {
      test("captures trace for rerank()", testConfig, () => {
        const root = findLatestSpan(events, ROOT_NAME);
        const trace = findRerankTrace(events);

        expectOperationParentedByRoot(trace.operation, root);
        expectAISDKParentSpan(trace.parent, "cohere");
        expect(operationName(trace.operation)).toBe("rerank");
        const input = isRecord(trace.parent?.input) ? trace.parent.input : null;
        expect(typeof input?.query).toBe("string");
        expect(Array.isArray(input?.documents)).toBe(true);
        if (Array.isArray(input?.documents)) {
          expect(input.documents.length).toBeGreaterThanOrEqual(2);
        }
        expect(trace.parent?.row.metadata).toMatchObject({
          document_count: expect.any(Number),
          topN: 2,
        });
        expect(Array.isArray(trace.parent?.output)).toBe(true);
        expect(
          (trace.parent?.output as Array<Record<string, unknown>>)?.[0],
        ).toMatchObject({
          index: expect.any(Number),
          relevance_score: expect.any(Number),
        });
      });
    }

    if (options.supportsOutputObjectScenario) {
      test(
        "captures Output.object schema on generateText()",
        testConfig,
        () => {
          const root = findLatestSpan(events, ROOT_NAME);
          const trace = findOutputObjectTrace(events);

          expectOperationParentedByRoot(trace.operation, root);
          expectAISDKParentSpan(trace.parent);
          expect(operationName(trace.operation)).toBe("output-object");
          const input = isRecord(trace.parent?.input)
            ? trace.parent.input
            : null;
          expect(input).toBeTruthy();
          expect(isRecord(input?.output)).toBe(true);

          const outputInput = isRecord(input?.output) ? input.output : null;
          expect(outputInput).toBeTruthy();
          expect("response_format" in (outputInput ?? {})).toBe(true);
          if (isRecord(outputInput?.response_format)) {
            expect(typeof outputInput.response_format.type).toBe("string");
            expect(outputInput.response_format.schema).toBeDefined();
          }
        },
      );
    }

    if (options.supportsAttachmentScenario) {
      test(
        "captures file attachment normalization in input",
        testConfig,
        () => {
          const root = findLatestSpan(events, ROOT_NAME);
          const trace = findAttachmentTrace(events);

          expectOperationParentedByRoot(trace.operation, root);
          expectAISDKParentSpan(trace.parent);
          expect(operationName(trace.operation)).toBe("attachment");
          const attachmentRef = extractFileAttachmentReference(
            trace.parent?.input,
          );
          expect(attachmentRef).toBeDefined();
          expect(attachmentRef).toMatchObject({
            content_type: "text/plain",
            key: expect.any(String),
            type: "braintrust_attachment",
          });
        },
      );
    }

    test("captures trace for generateText() with tools", testConfig, () => {
      const root = findLatestSpan(events, ROOT_NAME);
      const trace = findToolTrace(events);

      expectOperationParentedByRoot(trace.operation, root);
      expectAISDKParentSpan(trace.parent);
      expect(trace.parent?.input).toBeDefined();
      expect(trace.parent?.output).toBeDefined();
      expect(operationName(trace.operation)).toBe("tool");
      expect(toolNamesFromInput(trace.parent?.input)).toContain("get_weather");

      if (options.supportsToolExecution) {
        expect(trace.modelChildren.length).toBeGreaterThanOrEqual(2);
        trace.modelChildren.forEach(expectAISDKModelChildSpan);
        expect(trace.toolSpans.length).toBeGreaterThanOrEqual(1);
        expect(trace.toolSpans[0]?.input).toBeDefined();
        expect(trace.toolSpans[0]?.output).toBeDefined();
        expect(collectToolCallNames(trace.parent?.output)).toContain(
          "get_weather",
        );
        expect(collectToolResultNames(trace.parent?.output)).toContain(
          "get_weather",
        );
        expect(
          collectMetricValues(trace.modelChildren, "prompt_cached_tokens"),
        ).not.toHaveLength(0);
      } else {
        expect(trace.modelChildren.length).toBeGreaterThanOrEqual(1);
        trace.modelChildren.forEach(expectAISDKModelChildSpan);
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
        expect(operationName(trace.operation)).toBe("generate-object");
        expect(hasPromptLikeInput(trace.parent?.input)).toBe(true);
        const generateObjectInput = isRecord(trace.parent?.input)
          ? trace.parent.input
          : undefined;
        expect(isRecord(generateObjectInput?.schema)).toBe(true);
        if (isRecord(generateObjectInput?.schema)) {
          expect(generateObjectInput.schema.type).toBe("object");
        }
        expect(trace.parent?.output).toMatchObject({
          object: { city: "Paris" },
        });
        if (trace.child) {
          expectAISDKModelChildSpan(trace.child);
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
        expect(operationName(trace.operation)).toBe("stream-object");
        expect(hasPromptLikeInput(trace.parent?.input)).toBe(true);
        const streamObjectInput = isRecord(trace.parent?.input)
          ? trace.parent.input
          : undefined;
        expect(isRecord(streamObjectInput?.schema)).toBe(true);
        if (isRecord(streamObjectInput?.schema)) {
          expect(streamObjectInput.schema.type).toBe("object");
        }
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
          expectAISDKModelChildSpan(trace.child);
          expect(trace.child.output).toBeDefined();
        }
      });
    }

    if (options.sdkMajorVersion >= 4) {
      test(
        "captures sync streamText()/streamObject() paths in v4+",
        testConfig,
        () => {
          const root = findLatestSpan(events, ROOT_NAME);
          const streamTrace = findStreamTrace(events);

          expectOperationParentedByRoot(streamTrace.operation, root);
          expectAISDKParentSpan(streamTrace.parent);
          expect(operationName(streamTrace.operation)).toBe("stream");
          expect(streamTrace.parent?.span.name).toBe("streamText");

          if (options.supportsStreamObject) {
            const streamObjectTrace = findStreamObjectTrace(events);
            expectOperationParentedByRoot(streamObjectTrace.operation, root);
            expectAISDKParentSpan(streamObjectTrace.parent);
            expect(operationName(streamObjectTrace.operation)).toBe(
              "stream-object",
            );
            expect(streamObjectTrace.parent?.span.name).toBe("streamObject");
          }
        },
      );
    }

    if (options.agentSpanName) {
      test("captures trace for agent.generate()", testConfig, () => {
        const root = findLatestSpan(events, ROOT_NAME);
        const trace = findAgentGenerateTrace(events, options.agentSpanName!);

        expectOperationParentedByRoot(trace.operation, root);
        expectAISDKParentSpan(trace.parent);
        expect(operationName(trace.operation)).toBe("agent-generate");
        expect(hasPromptLikeInput(trace.parent?.input)).toBe(true);
        expect(trace.parent?.output).toBeDefined();
        expect(trace.modelChildren.length).toBeGreaterThanOrEqual(1);
        trace.modelChildren.forEach(expectAISDKModelChildSpan);
        expect(trace.latestChild?.output).toBeDefined();
      });

      test("captures trace for agent.stream()", testConfig, () => {
        const root = findLatestSpan(events, ROOT_NAME);
        const trace = findAgentStreamTrace(events, options.agentSpanName!);

        expectOperationParentedByRoot(trace.operation, root);
        expectAISDKParentSpan(trace.parent);
        expect(operationName(trace.operation)).toBe("agent-stream");
        expect(hasPromptLikeInput(trace.parent?.input)).toBe(true);
        expect(trace.parent?.metrics?.time_to_first_token).toEqual(
          expect.any(Number),
        );
        expect(trace.modelChildren.length).toBeGreaterThanOrEqual(1);
        trace.modelChildren.forEach(expectAISDKModelChildSpan);
        expect(trace.latestChild?.output).toBeDefined();
      });

      if (options.sdkMajorVersion === 5 && options.agentSpanName === "Agent") {
        test("captures Agent.stream() path in v5", testConfig, () => {
          const root = findLatestSpan(events, ROOT_NAME);
          const trace = findAgentStreamTrace(events, "Agent");

          expectOperationParentedByRoot(trace.operation, root);
          expectAISDKParentSpan(trace.parent);
          expect(operationName(trace.operation)).toBe("agent-stream");
          expect(trace.parent?.span.name).toBe("Agent.stream");
        });
      }
    }

    if (options.supportsDenyOutputOverrideScenario) {
      test(
        "captures denyOutputPaths override on instrumentation events",
        testConfig,
        () => {
          const root = findLatestSpan(events, ROOT_NAME);
          const trace = findDenyOutputOverrideTrace(events);

          expectOperationParentedByRoot(trace.operation, root);
          expectAISDKParentSpan(trace.parent);
          expect(operationName(trace.operation)).toBe("deny-output-override");

          const output = extractOutputRecord(trace.parent);
          expect(output).toBeDefined();
          if (output) {
            expect([undefined, "<omitted>"]).toContain(output.text);
            expect([undefined, "<omitted>"]).toContain(output._output);
          }
        },
      );
    }

    test("matches the shared span snapshot", testConfig, async () => {
      await expect(
        formatJsonFileSnapshot(
          buildSpanSummary(events, {
            agentSpanName: options.agentSpanName,
            sdkMajorVersion: options.sdkMajorVersion,
            supportsProviderCacheAssertions:
              options.supportsProviderCacheAssertions,
            supportsGenerateObject: options.supportsGenerateObject,
            supportsRerank: options.supportsRerank,
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
            sdkMajorVersion: options.sdkMajorVersion,
            supportsProviderCacheAssertions:
              options.supportsProviderCacheAssertions,
            supportsGenerateObject: options.supportsGenerateObject,
            supportsRerank: options.supportsRerank,
            supportsStreamObject: options.supportsStreamObject,
          }),
        ),
      ).toMatchFileSnapshot(payloadSnapshotPath);
    });
  });
}
