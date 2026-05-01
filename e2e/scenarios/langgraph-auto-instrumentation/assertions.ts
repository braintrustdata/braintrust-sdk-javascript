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
import { ROOT_NAME, SCENARIO_NAME } from "./constants.mjs";

function findDescendantSpan(
  events: CapturedLogEvent[],
  name: string,
  ancestorId: string | undefined,
  predicate: (event: CapturedLogEvent) => boolean = () => true,
): CapturedLogEvent | undefined {
  if (!ancestorId) {
    return undefined;
  }

  const queue = [ancestorId];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current)) {
      continue;
    }
    visited.add(current);

    for (const event of events) {
      if (!event.span.parentIds.includes(current)) {
        continue;
      }
      if (event.span.name === name && predicate(event)) {
        return event;
      }
      if (event.span.id) {
        queue.push(event.span.id);
      }
    }
  }

  return undefined;
}

function normalizeLangGraphPayloadRows(rows: unknown[]): unknown[] {
  return rows.map((row) => {
    if (!row || typeof row !== "object") {
      return row;
    }

    const normalized = structuredClone(row) as Record<string, unknown>;
    normalizeTokenMetrics(normalized.metrics);
    normalizeLLMOutput(normalized.output);
    normalizeLangchainMetadata(normalized);
    return normalized;
  });
}

const LANGCHAIN_LS_VOLATILE_KEYS = new Set([
  "max_tokens",
  "model",
  "stream",
  "stream_options",
  "temperature",
]);

function normalizeLangchainMetadata(value: unknown): void {
  if (!value || typeof value !== "object") {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      normalizeLangchainMetadata(item);
    }
    return;
  }

  const record = value as Record<string, unknown>;
  delete record.__pregel_task_id;
  delete record.ls_integration;

  if (
    record.versions &&
    typeof record.versions === "object" &&
    !Array.isArray(record.versions)
  ) {
    const versions = record.versions as Record<string, unknown>;
    for (const [key, version] of Object.entries(versions)) {
      if (key.startsWith("@langchain/") && typeof version === "string") {
        versions[key] = "<langchain-version>";
      }
    }
  }

  const hasLsKey = Object.keys(record).some((key) => key.startsWith("ls_"));
  if (hasLsKey) {
    for (const key of LANGCHAIN_LS_VOLATILE_KEYS) {
      delete record[key];
    }
  }

  for (const nested of Object.values(record)) {
    normalizeLangchainMetadata(nested);
  }
}

function normalizeTokenMetrics(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }

  const metrics = value as Record<string, unknown>;
  for (const [key, metricValue] of Object.entries(metrics)) {
    if (key.includes("token") && typeof metricValue === "number") {
      metrics[key] = "<number>";
    }
  }
}

function normalizeLLMOutput(value: unknown): void {
  if (!value || typeof value !== "object") {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      normalizeLLMOutput(item);
    }
    return;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") {
    record.text = "<llm-response>";
  }

  const kwargs = record.kwargs;
  if (kwargs && typeof kwargs === "object" && !Array.isArray(kwargs)) {
    const kwargsRecord = kwargs as Record<string, unknown>;
    if (typeof kwargsRecord.content === "string") {
      kwargsRecord.content = "<llm-response>";
    }
    normalizeTokenMetrics(kwargsRecord.usage_metadata);
  }

  for (const nested of Object.values(record)) {
    normalizeLLMOutput(nested);
  }
}

export function assertLangGraphAutoInstrumentation(options: {
  capturedEvents: CapturedLogEvent[];
  payloads: CapturedLogPayload[];
}): { payloadSummary: Json; spanSummary: Json } {
  const root = findLatestSpan(options.capturedEvents, ROOT_NAME);
  expect(root).toBeDefined();
  expect(root?.row.metadata).toMatchObject({
    scenario: SCENARIO_NAME,
  });

  const graphSpan = findChildSpans(
    options.capturedEvents,
    "LangGraph",
    root?.span.id,
  )[0];
  expect(graphSpan).toBeDefined();
  expect(graphSpan?.span.type).toBe("task");

  const sayHelloSpan = findDescendantSpan(
    options.capturedEvents,
    "sayHello",
    graphSpan?.span.id,
  );
  expect(sayHelloSpan).toBeDefined();
  expect(sayHelloSpan?.span.type).toBe("task");

  const sayByeSpan = findDescendantSpan(
    options.capturedEvents,
    "sayBye",
    graphSpan?.span.id,
  );
  expect(sayByeSpan).toBeDefined();
  expect(sayByeSpan?.span.type).toBe("task");

  const llmSpan = findDescendantSpan(
    options.capturedEvents,
    "ChatOpenAI",
    sayHelloSpan?.span.id,
    (event) =>
      typeof event.metrics?.completion_tokens === "number" &&
      typeof event.metrics?.prompt_tokens === "number" &&
      typeof event.metrics?.total_tokens === "number",
  );
  expect(llmSpan).toBeDefined();
  expect(llmSpan?.span.type).toBe("llm");
  expect(llmSpan?.metrics).toMatchObject({
    completion_tokens: expect.any(Number),
    prompt_tokens: expect.any(Number),
    total_tokens: expect.any(Number),
  });

  return {
    spanSummary: normalizeForSnapshot(
      [root, graphSpan, sayHelloSpan, llmSpan, sayByeSpan].map((event) =>
        summarizeWrapperContract(event!, ["model", "scenario"]),
      ) as Json,
    ),
    payloadSummary: normalizeForSnapshot(
      normalizeLangGraphPayloadRows(
        payloadRowsForRootSpan(options.payloads, root?.span.id),
      ) as Json,
    ),
  };
}
