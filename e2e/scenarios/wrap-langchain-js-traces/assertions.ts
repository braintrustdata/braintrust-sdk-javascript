import { expect } from "vitest";
import { normalizeForSnapshot, type Json } from "../../helpers/normalize";
import type {
  CapturedLogEvent,
  CapturedLogPayload,
} from "../../helpers/mock-braintrust-server";
import { findChildSpans, findLatestSpan } from "../../helpers/trace-selectors";
import {
  payloadRowsForRootSpan,
  summarizeWrapperContract,
} from "../../helpers/wrapper-contract";

/**
 * Normalizes LangChain payload rows to make snapshots deterministic by
 * replacing non-deterministic LLM output content and token counts with
 * stable placeholders.
 */
function normalizeLangchainPayloads(payloadRows: unknown[]): unknown[] {
  return payloadRows.map((payload) => {
    if (!payload || typeof payload !== "object") {
      return payload;
    }

    const row = structuredClone(payload) as Record<string, unknown>;

    if (row.metrics && typeof row.metrics === "object") {
      const metrics = row.metrics as Record<string, unknown>;
      for (const key of Object.keys(metrics)) {
        if (key.includes("token") && typeof metrics[key] === "number") {
          metrics[key] = "<number>";
        }
        if (key === "time_to_first_token") {
          metrics[key] = 0;
        }
      }
    }

    if (row.output && typeof row.output === "object") {
      normalizeOutputObject(row.output as Record<string, unknown>);
    }

    normalizeToolCallIds(row);
    normalizeLangchainVersions(row);

    return row;
  });
}

function normalizeOutputObject(obj: Record<string, unknown>): void {
  if (obj.llmOutput && typeof obj.llmOutput === "object") {
    const llmOutput = obj.llmOutput as Record<string, unknown>;
    if (llmOutput.tokenUsage && typeof llmOutput.tokenUsage === "object") {
      const tokenUsage = llmOutput.tokenUsage as Record<string, unknown>;
      for (const key of Object.keys(tokenUsage)) {
        tokenUsage[key] = "<number>";
      }
    }
  }

  if (Array.isArray(obj.generations)) {
    for (const batch of obj.generations) {
      if (!Array.isArray(batch)) continue;
      for (const generation of batch) {
        if (!generation || typeof generation !== "object") continue;
        const normalizedGeneration = generation as Record<string, unknown>;
        if (typeof normalizedGeneration.text === "string") {
          normalizedGeneration.text = "<llm-response>";
        }
        if (
          normalizedGeneration.message &&
          typeof normalizedGeneration.message === "object"
        ) {
          normalizeMessageObject(
            normalizedGeneration.message as Record<string, unknown>,
          );
        }
      }
    }
  }
}

function normalizeMessageObject(message: Record<string, unknown>): void {
  const kwargs = message.kwargs as Record<string, unknown> | undefined;
  if (!kwargs) return;

  if (typeof kwargs.content === "string" && kwargs.content !== "") {
    kwargs.content = "<llm-response>";
  }

  normalizeTokenCounts(kwargs.usage_metadata);
  if (
    kwargs.response_metadata &&
    typeof kwargs.response_metadata === "object"
  ) {
    const responseMetadata = kwargs.response_metadata as Record<
      string,
      unknown
    >;
    normalizeTokenCounts(responseMetadata.tokenUsage);
    normalizeTokenCounts(responseMetadata.usage);
  }
}

function normalizeTokenCounts(obj: unknown): void {
  if (!obj || typeof obj !== "object") return;
  const record = obj as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "number") {
      record[key] = "<number>";
    } else if (typeof value === "object" && value !== null) {
      normalizeTokenCounts(value);
    }
  }
}

function normalizeToolCallIds(obj: unknown): void {
  if (!obj || typeof obj !== "object") return;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      normalizeToolCallIds(item);
    }
    return;
  }

  const record = obj as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (
      (key === "tool_call_id" || key === "id") &&
      typeof value === "string" &&
      value.startsWith("call_")
    ) {
      record[key] = "<tool_call_id>";
    } else if (typeof value === "object" && value !== null) {
      normalizeToolCallIds(value);
    }
  }
}

function normalizeLangchainVersions(obj: unknown): void {
  if (!obj || typeof obj !== "object") return;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      normalizeLangchainVersions(item);
    }
    return;
  }

  const record = obj as Record<string, unknown>;
  if (
    record.versions &&
    typeof record.versions === "object" &&
    !Array.isArray(record.versions)
  ) {
    const versions = record.versions as Record<string, unknown>;
    for (const key of Object.keys(versions)) {
      if (key.startsWith("@langchain/") && typeof versions[key] === "string") {
        versions[key] = "<langchain-version>";
      }
    }
  }

  for (const value of Object.values(record)) {
    if (typeof value === "object" && value !== null) {
      normalizeLangchainVersions(value);
    }
  }
}

function findNamedChildSpan(
  capturedEvents: CapturedLogEvent[],
  names: string[],
  parentId: string | undefined,
) {
  for (const name of names) {
    const span = findChildSpans(capturedEvents, name, parentId)[0];
    if (span) {
      return span;
    }
  }

  return undefined;
}

export function assertLangchainTraces(options: {
  capturedEvents: CapturedLogEvent[];
  payloads: CapturedLogPayload[];
  rootName: string;
  scenarioName: string;
}): { payloadSummary: Json; spanSummary: Json } {
  const root = findLatestSpan(options.capturedEvents, options.rootName);
  const invokeOperation = findLatestSpan(
    options.capturedEvents,
    "langchain-invoke-operation",
  );
  const chainOperation = findLatestSpan(
    options.capturedEvents,
    "langchain-chain-operation",
  );
  const streamOperation = findLatestSpan(
    options.capturedEvents,
    "langchain-stream-operation",
  );
  const toolOperation = findLatestSpan(
    options.capturedEvents,
    "langchain-tool-operation",
  );
  const toolResultOperation = findLatestSpan(
    options.capturedEvents,
    "langchain-tool-result-operation",
  );

  expect(root).toBeDefined();
  expect(invokeOperation).toBeDefined();
  expect(chainOperation).toBeDefined();
  expect(streamOperation).toBeDefined();
  expect(toolOperation).toBeDefined();
  expect(toolResultOperation).toBeDefined();

  expect(root?.row.metadata).toMatchObject({
    scenario: options.scenarioName,
  });

  for (const operation of [
    invokeOperation,
    chainOperation,
    streamOperation,
    toolOperation,
    toolResultOperation,
  ]) {
    expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);
  }

  const invokeSpan = findNamedChildSpan(
    options.capturedEvents,
    ["ChatOpenAI"],
    invokeOperation?.span.id,
  );
  expect(invokeSpan).toBeDefined();
  expect(invokeSpan?.span.type).toBe("llm");

  const chainChildren = options.capturedEvents.filter(
    (event) =>
      event.span.parentIds.includes(chainOperation?.span.id ?? "") &&
      event.span.id !== chainOperation?.span.id,
  );
  expect(chainChildren.length).toBeGreaterThanOrEqual(1);

  const streamSpan = findNamedChildSpan(
    options.capturedEvents,
    ["ChatOpenAI"],
    streamOperation?.span.id,
  );
  expect(streamSpan).toBeDefined();
  expect(streamSpan?.span.type).toBe("llm");
  expect(streamSpan?.metrics).toMatchObject({
    time_to_first_token: expect.any(Number),
  });

  const toolSpan = findNamedChildSpan(
    options.capturedEvents,
    ["ChatOpenAI"],
    toolOperation?.span.id,
  );
  expect(toolSpan).toBeDefined();

  const toolOutputStr = JSON.stringify(toolSpan?.output ?? {});
  expect(toolOutputStr).toContain("get_weather");

  const toolResultSpans = options.capturedEvents.filter(
    (event) =>
      event.span.name === "ChatOpenAI" &&
      event.span.parentIds.includes(toolResultOperation?.span.id ?? ""),
  );
  expect(toolResultSpans.length).toBeGreaterThanOrEqual(2);

  return {
    spanSummary: normalizeForSnapshot(
      [
        root,
        invokeOperation,
        invokeSpan,
        chainOperation,
        ...chainChildren,
        streamOperation,
        streamSpan,
        toolOperation,
        toolSpan,
        toolResultOperation,
        ...toolResultSpans,
      ].map((event) =>
        summarizeWrapperContract(event!, ["model", "operation", "scenario"]),
      ) as Json,
    ),
    payloadSummary: normalizeForSnapshot(
      normalizeLangchainPayloads(
        payloadRowsForRootSpan(options.payloads, root?.span.id),
      ) as Json,
    ),
  };
}
