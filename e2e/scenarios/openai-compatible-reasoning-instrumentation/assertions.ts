import { createJsonFileStore } from "@braintrust/seinfeld";
import path from "node:path";
import { expect } from "vitest";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";
import { matchSpanTreeSnapshot, spanTreeFields } from "../../helpers/span-tree";
import { findAllSpans } from "../../helpers/trace-selectors";
import { REQUEST, ROOT_NAME, SCENARIO_NAME } from "./scenario.impl.mjs";

interface RawChunk {
  choices: Array<{
    index: number;
    delta: { content?: string | null; reasoning_content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  } | null;
}

export async function assertRecordedReasoning(options: {
  events: CapturedLogEvent[];
  originalScenarioDir: string;
  alias: string;
  mode: string;
  version: string;
  testFileUrl: string;
}) {
  const store = createJsonFileStore({
    rootDir: path.join(options.originalScenarioDir, "__cassettes__"),
  });
  const cassette = await store.load(options.alias);
  expect(cassette?.entries).toHaveLength(1);
  const entry = cassette!.entries[0];
  expect(entry.request.method).toBe("POST");
  expect(entry.request.url).toBe(
    "https://api.deepseek.com/v1/chat/completions",
  );
  expect(entry.request.body).toEqual({ kind: "json", value: REQUEST });
  expect(entry.response.status).toBe(200);
  expect(entry.response.headers["content-type"]).toContain("text/event-stream");
  expect(Number.isFinite(Date.parse(entry.recordedAt))).toBe(true);
  const body = entry.response.body;
  // The recorder stores larger SSE responses in a binary sidecar.
  const events =
    body.kind === "sse"
      ? body.chunks
      : body.kind === "binary" && store.loadBlob
        ? new TextDecoder("utf-8", { fatal: true })
            .decode(await store.loadBlob(options.alias, body.path))
            .replace(/\r\n/g, "\n")
            .split("\n\n")
            .filter((event) => event.trim())
        : undefined;
  if (!events) throw new Error("Expected genuine recorded SSE");

  // Build expectations from the retained wire events, never the SDK aggregator.
  const data = events.map((event) =>
    event
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n"),
  );
  expect(data.at(-1)).toBe("[DONE]");
  const chunks: RawChunk[] = data
    .filter((value) => value && value !== "[DONE]")
    .map((value) => JSON.parse(value));
  const indexes = [
    ...new Set(chunks.flatMap((c) => c.choices.map((v) => v.index))),
  ].sort((a, b) => a - b);
  expect(indexes.length).toBeGreaterThan(0);
  const expected = indexes.map((index) => {
    const choices = chunks.flatMap((chunk) =>
      chunk.choices.filter((choice) => choice.index === index),
    );
    const reasoning = choices
      .map((choice) => choice.delta.reasoning_content)
      .filter((value): value is string => typeof value === "string");
    expect(
      reasoning.filter((value) => value.length > 0).length,
    ).toBeGreaterThan(1);
    const content = choices
      .map((choice) => choice.delta.content)
      .filter((value): value is string => typeof value === "string")
      .join("");
    expect(content.trim().length).toBeGreaterThan(0);
    expect(choices.at(-1)?.finish_reason).toBe("stop");
    return { index, content, reasoning: reasoning.join("") };
  });
  const usage = chunks.filter((chunk) => chunk.usage).at(-1)?.usage;
  expect(usage?.prompt_tokens).toBeGreaterThan(0);
  expect(usage?.prompt_tokens).toBeLessThanOrEqual(512);
  expect(usage?.completion_tokens).toBeGreaterThan(0);
  expect(usage?.completion_tokens).toBeLessThanOrEqual(2048);

  const roots = findAllSpans(options.events, ROOT_NAME);
  const spans = findAllSpans(options.events, "Chat Completion");
  expect(roots).toHaveLength(1);
  expect(spans).toHaveLength(1);
  const span = spans[0];
  expect(span.span.parentIds).toEqual([roots[0].span.id]);
  expect(roots[0].metadata).toMatchObject({
    scenario: SCENARIO_NAME,
    openaiSdkVersion: options.version,
  });
  const output = span.output as Array<{
    index: number;
    message: { content: string; reasoning_content?: string };
    finish_reason: string;
  }>;
  expect(
    output.map((choice) => ({
      index: choice.index,
      content: choice.message.content,
    })),
  ).toEqual(expected.map(({ index, content }) => ({ index, content })));
  // On the untouched base this must fail on missing reasoning, before snapshots.
  expect(
    output.map((choice) => ({
      index: choice.index,
      reasoning: choice.message.reasoning_content,
    })),
  ).toEqual(expected.map(({ index, reasoning }) => ({ index, reasoning })));
  expect(output.map((choice) => choice.finish_reason)).toEqual(
    indexes.map(() => "stop"),
  );
  expect(span.metrics).toMatchObject({
    prompt_tokens: usage!.prompt_tokens,
    completion_tokens: usage!.completion_tokens,
    tokens: usage!.total_tokens,
  });
  await matchSpanTreeSnapshot(
    [...roots, ...spans].map((event) => ({
      event,
      fields: { ...spanTreeFields(event), context: event.context },
    })),
    resolveFileSnapshotPath(
      options.testFileUrl,
      `${options.alias}-${options.mode}.span-tree.json`,
    ),
  );
}
