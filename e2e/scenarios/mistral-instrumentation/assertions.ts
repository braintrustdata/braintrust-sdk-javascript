import { beforeAll, describe, expect, test } from "vitest";
import type {
  CapturedLogEvent,
  CapturedLogPayload,
  CapturedLogRow,
} from "../../helpers/mock-braintrust-server";
import type { Json } from "../../helpers/normalize";
import { normalizeForSnapshot } from "../../helpers/normalize";
import {
  formatJsonFileSnapshot,
  resolveFileSnapshotPath,
} from "../../helpers/file-snapshot";
import { withScenarioHarness } from "../../helpers/scenario-harness";
import { findChildSpans, findLatestSpan } from "../../helpers/trace-selectors";
import {
  payloadRowsForRootSpan,
  summarizeWrapperContract,
} from "../../helpers/wrapper-contract";
import {
  FIM_MODEL,
  CHAT_MODEL,
  AGENT_MODEL,
  EMBEDDING_MODEL,
  ROOT_NAME,
  SCENARIO_NAME,
} from "./constants.mjs";

type RunMistralScenario = (harness: {
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

function findMistralSpan(
  events: CapturedLogEvent[],
  parentId: string | undefined,
  names: string[],
) {
  for (const name of names) {
    const spans = findChildSpans(events, name, parentId);
    const spanWithOutput = spans.find((candidate) => candidate.output != null);
    if (spanWithOutput) {
      return spanWithOutput;
    }
    if (spans[0]) {
      return spans[0];
    }
  }

  return undefined;
}

function isRecord(value: Json | undefined): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
      key in metadata ? [[key, metadata[key] as Json]] : [],
    ),
  );

  return Object.keys(picked).length > 0 ? (picked as Json) : null;
}

function summarizeInput(input: unknown): Json {
  if (Array.isArray(input)) {
    const roles = input
      .map((message) =>
        isRecord(message as Json) && typeof message.role === "string"
          ? message.role
          : null,
      )
      .filter((role): role is string => role !== null);

    return {
      item_count: input.length,
      roles,
      type: "messages",
    };
  }

  if (typeof input === "string") {
    return "<string>";
  }

  if (!isRecord(input as Json)) {
    return null;
  }

  return {
    keys: Object.keys(input).sort(),
    type: "object",
  };
}

function summarizeOutput(output: unknown): Json {
  if (Array.isArray(output)) {
    const firstChoice = output[0] as Json;
    if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) {
      return {
        choice_count: output.length,
        type: "array",
      };
    }

    const message = firstChoice.message;
    const toolCalls =
      (Array.isArray(message.tool_calls) && message.tool_calls) ||
      (Array.isArray(message.toolCalls) && message.toolCalls) ||
      [];

    return {
      choice_count: output.length,
      has_content:
        typeof message.content === "string"
          ? message.content.length > 0
          : false,
      role: typeof message.role === "string" ? message.role : null,
      tool_call_count: toolCalls.length,
      type: "choices",
    };
  }

  if (!isRecord(output as Json)) {
    return output === undefined ? null : "<scalar>";
  }

  if (typeof output.embedding_length === "number") {
    return {
      embedding_length: "<number>",
      type: "embedding",
    };
  }

  return {
    keys: Object.keys(output).sort(),
    type: "object",
  };
}

function summarizePayloadRow(row: CapturedLogRow): Json {
  const metrics =
    typeof row.metrics === "object" &&
    row.metrics !== null &&
    !Array.isArray(row.metrics)
      ? (row.metrics as Record<string, unknown>)
      : {};

  return {
    has_input: row.input !== undefined && row.input !== null,
    has_output: row.output !== undefined && row.output !== null,
    input: summarizeInput(row.input),
    metadata: pickMetadata(
      row.metadata as Record<string, unknown> | undefined,
      ["model", "operation", "provider", "scenario"],
    ),
    metric_keys: Object.keys(metrics)
      .filter((key) => key !== "start" && key !== "end")
      .sort(),
    output: summarizeOutput(row.output),
    span_id: typeof row.span_id === "string" ? row.span_id : null,
  } satisfies Json;
}

function mergeRecordValues(
  left: Record<string, unknown> | undefined,
  right: unknown,
): Record<string, unknown> | undefined {
  if (!right || typeof right !== "object" || Array.isArray(right)) {
    return left;
  }

  return {
    ...(left || {}),
    ...(right as Record<string, unknown>),
  };
}

function mergePayloadRows(rows: CapturedLogRow[]): CapturedLogRow[] {
  const mergedBySpan = new Map<string, CapturedLogRow>();
  const spanOrder: string[] = [];

  for (const row of rows) {
    const spanId =
      typeof row.span_id === "string"
        ? row.span_id
        : `unknown-${spanOrder.length}`;
    const existing = mergedBySpan.get(spanId);

    if (!existing) {
      mergedBySpan.set(spanId, {
        ...row,
      });
      spanOrder.push(spanId);
      continue;
    }

    mergedBySpan.set(spanId, {
      ...existing,
      ...(row.input !== undefined && row.input !== null
        ? {
            input: row.input,
          }
        : {}),
      ...(row.output !== undefined && row.output !== null
        ? {
            output: row.output,
          }
        : {}),
      metadata: mergeRecordValues(
        existing.metadata as Record<string, unknown> | undefined,
        row.metadata,
      ),
      metrics: mergeRecordValues(
        existing.metrics as Record<string, unknown> | undefined,
        row.metrics,
      ),
    });
  }

  return spanOrder
    .map((spanId) => mergedBySpan.get(spanId))
    .filter((row): row is CapturedLogRow => row !== undefined);
}

function buildSpanSummary(events: CapturedLogEvent[]): Json {
  const chatCompleteOperation = findLatestSpan(
    events,
    "mistral-chat-complete-operation",
  );
  const chatStreamOperation = findLatestSpan(
    events,
    "mistral-chat-stream-operation",
  );
  const fimCompleteOperation = findLatestSpan(
    events,
    "mistral-fim-complete-operation",
  );
  const fimStreamOperation = findLatestSpan(
    events,
    "mistral-fim-stream-operation",
  );
  const agentsCompleteOperation = findLatestSpan(
    events,
    "mistral-agents-complete-operation",
  );
  const agentsStreamOperation = findLatestSpan(
    events,
    "mistral-agents-stream-operation",
  );
  const embeddingsOperation = findLatestSpan(
    events,
    "mistral-embeddings-operation",
  );

  return normalizeForSnapshot(
    [
      findLatestSpan(events, ROOT_NAME),
      chatCompleteOperation,
      findMistralSpan(events, chatCompleteOperation?.span.id, [
        "mistral.chat.complete",
      ]),
      chatStreamOperation,
      findMistralSpan(events, chatStreamOperation?.span.id, [
        "mistral.chat.stream",
      ]),
      fimCompleteOperation,
      findMistralSpan(events, fimCompleteOperation?.span.id, [
        "mistral.fim.complete",
      ]),
      fimStreamOperation,
      findMistralSpan(events, fimStreamOperation?.span.id, [
        "mistral.fim.stream",
      ]),
      agentsCompleteOperation,
      findMistralSpan(events, agentsCompleteOperation?.span.id, [
        "mistral.agents.complete",
      ]),
      agentsStreamOperation,
      findMistralSpan(events, agentsStreamOperation?.span.id, [
        "mistral.agents.stream",
      ]),
      embeddingsOperation,
      findMistralSpan(events, embeddingsOperation?.span.id, [
        "mistral.embeddings.create",
      ]),
    ].map((event) =>
      summarizeWrapperContract(event!, [
        "model",
        "operation",
        "provider",
        "scenario",
      ]),
    ) as Json,
  );
}

function buildPayloadSummary(
  events: CapturedLogEvent[],
  payloads: CapturedLogPayload[],
): Json {
  const root = findLatestSpan(events, ROOT_NAME);
  const payloadRows = payloadRowsForRootSpan(payloads, root?.span.id);
  const mergedRows = mergePayloadRows(payloadRows);
  return normalizeForSnapshot(
    mergedRows.map((row) => summarizePayloadRow(row)),
  );
}

export function defineMistralInstrumentationAssertions(options: {
  name: string;
  runScenario: RunMistralScenario;
  snapshotName: string;
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
    let payloads: CapturedLogPayload[] = [];

    beforeAll(async () => {
      await withScenarioHarness(async (harness) => {
        await options.runScenario(harness);
        events = harness.events();
        payloads = harness.payloads();
      });
    }, options.timeoutMs);

    test("captures the root trace for the scenario", testConfig, () => {
      const root = findLatestSpan(events, ROOT_NAME);

      expect(root).toBeDefined();
      expect(root?.row.metadata).toMatchObject({
        scenario: SCENARIO_NAME,
      });
    });

    test("captures trace for chat.complete()", testConfig, () => {
      const root = findLatestSpan(events, ROOT_NAME);
      const operation = findLatestSpan(
        events,
        "mistral-chat-complete-operation",
      );
      const span = findMistralSpan(events, operation?.span.id, [
        "mistral.chat.complete",
      ]);

      expect(operation).toBeDefined();
      expect(span).toBeDefined();
      expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);
      expect(span?.span.type).toBe("llm");
      expect(span?.row.metadata).toMatchObject({
        model: CHAT_MODEL,
        provider: "mistral",
      });
      expect(span?.output).toBeDefined();
    });

    test("captures trace for chat.stream()", testConfig, () => {
      const root = findLatestSpan(events, ROOT_NAME);
      const operation = findLatestSpan(events, "mistral-chat-stream-operation");
      const span = findMistralSpan(events, operation?.span.id, [
        "mistral.chat.stream",
      ]);

      expect(operation).toBeDefined();
      expect(span).toBeDefined();
      expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);
      expect(span?.span.type).toBe("llm");
      expect(span?.row.metadata).toMatchObject({
        model: CHAT_MODEL,
        provider: "mistral",
      });
      expect(span?.metrics?.time_to_first_token).toEqual(expect.any(Number));
      expect(span?.output).toBeDefined();
    });

    test("captures trace for fim.complete()", testConfig, () => {
      const root = findLatestSpan(events, ROOT_NAME);
      const operation = findLatestSpan(
        events,
        "mistral-fim-complete-operation",
      );
      const span = findMistralSpan(events, operation?.span.id, [
        "mistral.fim.complete",
      ]);

      expect(operation).toBeDefined();
      expect(span).toBeDefined();
      expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);
      expect(span?.span.type).toBe("llm");
      expect(span?.row.metadata).toMatchObject({
        model: FIM_MODEL,
        provider: "mistral",
      });
      expect(span?.input).toEqual(expect.any(String));
      expect(span?.metrics?.time_to_first_token).toEqual(expect.any(Number));
      expect(span?.output).toBeDefined();
    });

    test("captures trace for fim.stream()", testConfig, () => {
      const root = findLatestSpan(events, ROOT_NAME);
      const operation = findLatestSpan(events, "mistral-fim-stream-operation");
      const span = findMistralSpan(events, operation?.span.id, [
        "mistral.fim.stream",
      ]);

      expect(operation).toBeDefined();
      expect(span).toBeDefined();
      expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);
      expect(span?.span.type).toBe("llm");
      expect(span?.row.metadata).toMatchObject({
        model: FIM_MODEL,
        provider: "mistral",
      });
      expect(span?.input).toEqual(expect.any(String));
      expect(span?.metrics?.time_to_first_token).toEqual(expect.any(Number));
      expect(span?.output).toBeDefined();
    });

    test("captures trace for agents.complete()", testConfig, () => {
      const root = findLatestSpan(events, ROOT_NAME);
      const operation = findLatestSpan(
        events,
        "mistral-agents-complete-operation",
      );
      const span = findMistralSpan(events, operation?.span.id, [
        "mistral.agents.complete",
      ]);
      const metadata = span?.row.metadata as
        | Record<string, unknown>
        | undefined;
      const input = span?.input as Array<{ role?: string }> | undefined;

      expect(operation).toBeDefined();
      expect(span).toBeDefined();
      expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);
      expect(span?.span.type).toBe("llm");
      expect(metadata).toMatchObject({
        provider: "mistral",
        agentId: expect.any(String),
      });
      if (typeof metadata?.model === "string") {
        expect(metadata.model).toBe(AGENT_MODEL);
      }
      expect(input).toEqual(expect.any(Array));
      expect(input?.[0]?.role).toBe("user");
      expect(span?.metrics?.time_to_first_token).toEqual(expect.any(Number));
      expect(span?.output).toBeDefined();
    });

    test("captures trace for agents.stream()", testConfig, () => {
      const root = findLatestSpan(events, ROOT_NAME);
      const operation = findLatestSpan(
        events,
        "mistral-agents-stream-operation",
      );
      const span = findMistralSpan(events, operation?.span.id, [
        "mistral.agents.stream",
      ]);
      const metadata = span?.row.metadata as
        | Record<string, unknown>
        | undefined;
      const input = span?.input as Array<{ role?: string }> | undefined;

      expect(operation).toBeDefined();
      expect(span).toBeDefined();
      expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);
      expect(span?.span.type).toBe("llm");
      expect(metadata).toMatchObject({
        provider: "mistral",
        agentId: expect.any(String),
      });
      if (typeof metadata?.model === "string") {
        expect(metadata.model).toBe(AGENT_MODEL);
      }
      expect(input).toEqual(expect.any(Array));
      expect(input?.[0]?.role).toBe("user");
      expect(span?.metrics?.time_to_first_token).toEqual(expect.any(Number));
      expect(span?.output).toBeDefined();
    });

    test("captures trace for embeddings.create()", testConfig, () => {
      const root = findLatestSpan(events, ROOT_NAME);
      const operation = findLatestSpan(events, "mistral-embeddings-operation");
      const span = findMistralSpan(events, operation?.span.id, [
        "mistral.embeddings.create",
      ]);
      const output = span?.output as { embedding_length?: number } | undefined;

      expect(operation).toBeDefined();
      expect(span).toBeDefined();
      expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);
      expect(span?.span.type).toBe("llm");
      expect(span?.row.metadata).toMatchObject({
        model: EMBEDDING_MODEL,
        provider: "mistral",
      });
      expect(output?.embedding_length).toEqual(expect.any(Number));
      expect(output?.embedding_length).toBeGreaterThan(0);
    });

    test("matches the shared span snapshot", testConfig, async () => {
      await expect(
        formatJsonFileSnapshot(buildSpanSummary(events)),
      ).toMatchFileSnapshot(spanSnapshotPath);
    });

    test("matches the shared payload snapshot", testConfig, async () => {
      await expect(
        formatJsonFileSnapshot(buildPayloadSummary(events, payloads)),
      ).toMatchFileSnapshot(payloadSnapshotPath);
    });
  });
}
