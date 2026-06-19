import { beforeAll, expect, test, vi } from "vitest";
import { z } from "zod";

import { agentAssertionScorer, Eval } from "./exports";
import { configureNode } from "./node/config";
import type { AgentAssertionScoreMetadata } from "./agent-assertions";
import type { Trace } from "./trace";
import type { Score } from "../util";

beforeAll(() => {
  configureNode();
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
      assert.contains(output.answer, /hi/i, "answer contains greeting"),
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
  expect(score.score).toBe(0.75);
  expect(score.metadata).toEqual({
    assertions: [
      { name: "answer matches", passed: true },
      { name: "count is three", passed: false },
      { name: "answer contains greeting", passed: true },
      { name: "output schema", passed: true },
    ],
    failed: ["count is three: expected 2 to equal 3"],
  } satisfies AgentAssertionScoreMetadata);
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
        input: { city: /Brook/ },
        output: { forecast: /sunny/ },
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
