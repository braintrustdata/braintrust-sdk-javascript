import { beforeAll, expect, expectTypeOf, test, vi } from "vitest";
import { z } from "zod";

import { agentAssertionScorer, Eval } from "./exports";
import { configureNode } from "./node/config";
import type { AgentAssertionScoreMetadata } from "./agent-assertions";
import type { Trace } from "./trace";
import type { Score } from "../util";

beforeAll(() => {
  configureNode();
});

test("agentAssertionScorer callback receives default metadata", async () => {
  let callbackMetadata: unknown;
  const scorer = agentAssertionScorer(({ metadata, assert }) => {
    expectTypeOf(metadata).toEqualTypeOf<Record<string, unknown>>();
    callbackMetadata = metadata;
    return [assert.equals(metadata, {}, "metadata defaults to empty object")];
  });

  const score = (await scorer({
    input: "hello",
    output: "done",
  })) as Score;

  expect(callbackMetadata).toEqual({});
  expect(score.score).toBe(1);
});

test("agentAssertionScorer emits one score with assertion metadata", async () => {
  const scorer = agentAssertionScorer<
    string,
    { answer: string; count: number },
    { answer: string }
  >(
    ({ output, expected, assert }) => [
      assert.equals(output.answer, expected.answer, "answer matches"),
      assert.equals(output.count, 3, "count is three"),
      assert.contains(output.answer, /^hi$/, "answer contains greeting"),
      assert.contains(output, "hi", "output object contains greeting"),
      assert.matches(
        output,
        z.object({ answer: z.string(), count: z.number() }),
        "output schema",
      ),
    ],
    { name: "agent_contract" },
  );

  const score = (await scorer({
    input: "hello",
    expected: { answer: "hi" },
    output: { answer: "hi", count: 2 },
    metadata: {},
  })) as Score;

  expect(score.name).toBe("agent_contract");
  expect(score.score).toBe(0.8);
  expect(score.metadata).toEqual({
    assertions: [
      { name: "answer matches", passed: true },
      { name: "count is three", passed: false },
      { name: "answer contains greeting", passed: true },
      { name: "output object contains greeting", passed: true },
      { name: "output schema", passed: true },
    ],
    failed: ["count is three: expected 2 to equal 3"],
  } satisfies AgentAssertionScoreMetadata);
});

test("agentAssertionScorer compares object keys before undefined values", async () => {
  const scorer = agentAssertionScorer(({ assert }) => [
    assert.equals(
      { a: undefined },
      { b: undefined },
      "different undefined keys are not equal",
    ),
    assert.notEquals(
      { a: undefined },
      { b: undefined },
      "different undefined keys are not equal with notEquals",
    ),
  ]);

  const score = (await scorer({
    input: "hello",
    output: "done",
    metadata: {},
  })) as Score;

  expect(score.score).toBe(0.5);
  expect(score.metadata).toMatchObject({
    assertions: [
      { name: "different undefined keys are not equal", passed: false },
      {
        name: "different undefined keys are not equal with notEquals",
        passed: true,
      },
    ],
  });
  const metadata = score.metadata as AgentAssertionScoreMetadata;
  expect(metadata.failed).toEqual([
    'different undefined keys are not equal: expected {"a":undefined} to equal {"b":undefined}',
  ]);
});

test("agentAssertionScorer evaluates trace-backed tool assertions after collection", async () => {
  const getSpans = vi.fn().mockResolvedValue([
    {
      input: { city: "Brooklyn" },
      output: { forecast: "72F and sunny" },
      span_attributes: { type: "tool", name: "tool: get_weather" },
    },
    {
      input: { city: "Brooklyn" },
      output: { source: "cache" },
      span_attributes: { type: "tool", name: "lookup_cache" },
    },
  ]);
  const trace: Trace = {
    getConfiguration: () => ({
      object_type: "experiment",
      object_id: "experiment-id",
      root_span_id: "root-span-id",
    }),
    getSpans,
    getThread: vi.fn(),
  };
  const callbackOrder: string[] = [];
  const scorer = agentAssertionScorer(({ assert }) => {
    callbackOrder.push("callback");
    return [
      assert.calledTool("get_weather", {
        input: /Brooklyn/,
        output: /sunny/,
        times: 1,
      }),
      assert.calledTool("charge_card"),
      assert.notCalledTool("refund_customer"),
      assert.toolOrder(["get_weather", "lookup_cache"]),
      assert.maxToolCalls(2),
    ];
  });

  const score = (await scorer({
    input: "weather",
    output: "done",
    metadata: {},
    trace,
  })) as Score;

  expect(callbackOrder).toEqual(["callback"]);
  expect(getSpans).toHaveBeenCalledWith({ spanType: ["tool"] });
  expect(score.name).toBe("assertions");
  expect(score.score).toBe(0.8);
  expect(score.metadata).toEqual({
    assertions: [
      { name: "called tool get_weather", passed: true },
      { name: "called tool charge_card", passed: false },
      { name: "did not call tool refund_customer", passed: true },
      { name: "tool order", passed: true },
      { name: "at most 2 tool calls", passed: true },
    ],
    failed: [
      'called tool charge_card: expected tool "charge_card" to be called; found 0 matching calls',
    ],
  } satisfies AgentAssertionScoreMetadata);
});

test("agentAssertionScorer requires undefined matcher keys to exist", async () => {
  const getSpans = vi.fn().mockResolvedValue([
    {
      input: {},
      output: {},
      span_attributes: { type: "tool", name: "lookup_cache" },
    },
    {
      input: { foo: undefined },
      output: { cached: undefined },
      span_attributes: { type: "tool", name: "lookup_cache" },
    },
  ]);
  const trace: Trace = {
    getConfiguration: () => ({
      object_type: "experiment",
      object_id: "experiment-id",
      root_span_id: "root-span-id",
    }),
    getSpans,
    getThread: vi.fn(),
  };
  const scorer = agentAssertionScorer(({ assert }) => [
    assert.calledTool(
      "lookup_cache",
      {
        input: { foo: undefined },
        output: { cached: undefined },
        times: 1,
      },
      "matches present undefined fields once",
    ),
  ]);

  const score = (await scorer({
    input: "cache",
    output: "done",
    metadata: {},
    trace,
  })) as Score;

  expect(score.score).toBe(1);
  expect(score.metadata).toEqual({
    assertions: [
      { name: "matches present undefined fields once", passed: true },
    ],
    failed: [],
  } satisfies AgentAssertionScoreMetadata);
});

test("agentAssertionScorer applies explicit undefined input and output matchers", async () => {
  const getSpans = vi.fn().mockResolvedValue([
    {
      input: { foo: "present" },
      output: { cached: false },
      span_attributes: { type: "tool", name: "lookup_cache" },
    },
    {
      input: undefined,
      output: undefined,
      span_attributes: { type: "tool", name: "lookup_cache" },
    },
  ]);
  const trace: Trace = {
    getConfiguration: () => ({
      object_type: "experiment",
      object_id: "experiment-id",
      root_span_id: "root-span-id",
    }),
    getSpans,
    getThread: vi.fn(),
  };
  const scorer = agentAssertionScorer(({ assert }) => [
    assert.calledTool(
      "lookup_cache",
      {
        input: undefined,
        output: undefined,
        times: 1,
      },
      "matches undefined input and output once",
    ),
  ]);

  const score = (await scorer({
    input: "cache",
    output: "done",
    metadata: {},
    trace,
  })) as Score;

  expect(score.score).toBe(1);
  expect(score.metadata).toEqual({
    assertions: [
      { name: "matches undefined input and output once", passed: true },
    ],
    failed: [],
  } satisfies AgentAssertionScoreMetadata);
});

test("agentAssertionScorer matches object tool inputs and outputs with regexes", async () => {
  const inputMatcher = /Brooklyn/g;
  const outputMatcher = /sunny/g;
  inputMatcher.lastIndex = 99;
  outputMatcher.lastIndex = 99;
  const getSpans = vi.fn().mockResolvedValue([
    {
      input: { city: "Brooklyn" },
      output: { forecast: "sunny" },
      span_attributes: { type: "tool", name: "get_weather" },
    },
    {
      input: { city: "Brooklyn" },
      output: { forecast: "sunny" },
      span_attributes: { type: "tool", name: "get_weather" },
    },
  ]);
  const trace: Trace = {
    getConfiguration: () => ({
      object_type: "experiment",
      object_id: "experiment-id",
      root_span_id: "root-span-id",
    }),
    getSpans,
    getThread: vi.fn(),
  };
  const scorer = agentAssertionScorer(({ assert }) => [
    assert.calledTool(
      "get_weather",
      {
        input: inputMatcher,
        output: outputMatcher,
        times: 2,
      },
      "matches repeated object tool calls",
    ),
  ]);

  const score = (await scorer({
    input: "weather",
    output: "done",
    metadata: {},
    trace,
  })) as Score;

  expect(score.score).toBe(1);
  expect(score.metadata).toEqual({
    assertions: [{ name: "matches repeated object tool calls", passed: true }],
    failed: [],
  } satisfies AgentAssertionScoreMetadata);
});

test("agentAssertionScorer matches raw string regexes and array matchers", async () => {
  const getSpans = vi.fn().mockResolvedValue([
    {
      input: {
        city: "Brooklyn",
        messages: [{ content: "hi" }],
        neighborhoods: ["Brooklyn"],
      },
      output: {
        status: "sunny",
        reports: [{ summary: "hi Brooklyn" }],
      },
      span_attributes: { type: "tool", name: "get_weather" },
    },
  ]);
  const trace: Trace = {
    getConfiguration: () => ({
      object_type: "experiment",
      object_id: "experiment-id",
      root_span_id: "root-span-id",
    }),
    getSpans,
    getThread: vi.fn(),
  };
  const scorer = agentAssertionScorer(({ assert }) => [
    assert.contains("hi", /^hi$/, "contains raw string"),
    assert.calledTool(
      "get_weather",
      {
        input: {
          city: /^Brooklyn$/,
          messages: [{ content: /^hi$/ }],
          neighborhoods: [/^Brooklyn$/],
        },
        output: {
          status: /^sunny$/,
          reports: [{ summary: /Brooklyn$/ }],
        },
      },
      "matches nested tool values",
    ),
  ]);

  const score = (await scorer({
    input: "weather",
    output: "done",
    metadata: {},
    trace,
  })) as Score;

  expect(score.score).toBe(1);
  expect(score.metadata).toEqual({
    assertions: [
      { name: "contains raw string", passed: true },
      { name: "matches nested tool values", passed: true },
    ],
    failed: [],
  } satisfies AgentAssertionScoreMetadata);
});

test("agentAssertionScorer matches tool names from span metadata", async () => {
  const getSpans = vi.fn().mockResolvedValue([
    {
      input: { city: "Vienna" },
      output: { forecast: "Sunny in Vienna" },
      metadata: {
        provider: "openrouter",
        tool_name: "lookup_weather",
      },
      span_attributes: { type: "tool", name: "openrouter.tool" },
    },
    {
      input: { query: "Vienna weather" },
      output: { result: "sunny" },
      metadata: {
        "gen_ai.tool.name": "web_search",
      },
      span_attributes: { type: "tool", name: "tool" },
    },
    {
      input: { path: "README.md" },
      output: { contents: "hello" },
      metadata: {
        "gen_ai.tool.name": "read_file",
        "mcp.server": "filesystem",
      },
      span_attributes: { type: "tool", name: "tool: filesystem/read_file" },
    },
    {
      input: { query: "docs" },
      output: { result: "found" },
      metadata: {
        "gen_ai.tool.name": "search",
        "mcp.server": "browser",
      },
      span_attributes: { type: "tool", name: "tool: search" },
    },
  ]);
  const trace: Trace = {
    getConfiguration: () => ({
      object_type: "experiment",
      object_id: "experiment-id",
      root_span_id: "root-span-id",
    }),
    getSpans,
    getThread: vi.fn(),
  };
  const scorer = agentAssertionScorer(({ assert }) => [
    assert.calledTool("lookup_weather", {
      input: { city: "Vienna" },
      output: { forecast: /Vienna$/ },
    }),
    assert.calledTool("web_search"),
    assert.notCalledTool("openrouter.tool"),
    assert.calledTool("filesystem/read_file"),
    assert.calledTool("browser/search"),
    assert.notCalledTool("read_file"),
    assert.notCalledTool("search"),
  ]);

  const score = (await scorer({
    input: "weather",
    output: "done",
    metadata: {},
    trace,
  })) as Score;

  expect(score.score).toBe(1);
  expect(score.metadata).toEqual({
    assertions: [
      { name: "called tool lookup_weather", passed: true },
      { name: "called tool web_search", passed: true },
      { name: "did not call tool openrouter.tool", passed: true },
      { name: "called tool filesystem/read_file", passed: true },
      { name: "called tool browser/search", passed: true },
      { name: "did not call tool read_file", passed: true },
      { name: "did not call tool search", passed: true },
    ],
    failed: [],
  } satisfies AgentAssertionScoreMetadata);
});

test("agentAssertionScorer works as an Eval scorer", async () => {
  const result = await Eval(
    "agent assertions",
    {
      data: [
        { input: "hello", expected: "hello world" },
        { input: "bye", expected: "bye world" },
      ] as const,
      task: (input) => `${input} world` as const,
      scores: [
        agentAssertionScorer(({ output, expected, assert }) => [
          assert.equals(output, expected, "output matches expected"),
          assert.contains(output, "world", "output contains world"),
        ]),
      ],
    },
    { noSendLogs: true },
  );

  expect(result.results[0].scores.assertions).toBe(1);
  expect(result.results[1].scores.assertions).toBe(1);
  expect(result.summary.scores.assertions.score).toBe(1);
});
