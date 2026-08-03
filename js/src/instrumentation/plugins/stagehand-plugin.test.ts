import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  extractActInput,
  extractActionSummary,
  extractAgentInput,
  extractAgentMetrics,
  extractAgentOutput,
  extractExtractInput,
  extractInstructionInput,
  extractStructuredResult,
} from "./stagehand-plugin";

const SECRET = "must-not-be-captured";

describe("Stagehand capture contract", () => {
  it("captures only instructions or action methods for act", () => {
    expect(extractActInput([])).toBeUndefined();
    expect(extractActInput(["click submit"])).toEqual({
      instruction: "click submit",
    });
    expect(
      extractActInput([
        {
          arguments: [SECRET],
          description: SECRET,
          method: "click",
          selector: SECRET,
          apiKey: SECRET,
        },
      ]),
    ).toEqual({ action: { method: "click" } });
  });

  it("summarizes actions without selectors, arguments, or descriptions", () => {
    const captured = extractActionSummary({
      actionDescription: SECRET,
      actions: [
        {
          arguments: [SECRET],
          description: SECRET,
          method: "click",
          selector: SECRET,
        },
        { method: "type", selector: SECRET },
      ],
      cacheStatus: "HIT",
      message: SECRET,
      success: true,
    });
    expect(captured).toEqual({
      success: true,
      action_count: 2,
      methods: ["click", "type"],
    });
    expect(JSON.stringify(captured)).not.toContain(SECRET);
  });

  it("captures observe instructions but not runtime options", () => {
    expect(
      extractInstructionInput([
        {
          instruction: "find the login button",
          model: "model-name",
          variableNames: [SECRET],
        },
      ]),
    ).toEqual({ instruction: "find the login button" });
  });

  it("converts extract Zod schemas and omits raw page-text output", () => {
    const input = extractExtractInput([
      "extract the profile",
      z.object({ name: z.string(), age: z.number() }),
      { apiKey: SECRET },
    ]);
    expect(input).toMatchObject({
      instruction: "extract the profile",
      schema: {
        properties: {
          age: { type: "number" },
          name: { type: "string" },
        },
        type: "object",
      },
    });
    expect(extractStructuredResult("entire page text", [])).toBeUndefined();
    expect(
      extractStructuredResult(
        { cacheStatus: "MISS", name: "Ada", nested: { ok: true } },
        ["extract the profile"],
      ),
    ).toEqual({ name: "Ada", nested: { ok: true } });
  });

  it("captures the bounded agent input, result, actions, and token metrics", () => {
    const input = extractAgentInput([
      {
        instruction: "research this topic",
        output: z.object({ answer: z.string() }),
        messages: [{ content: SECRET }],
        callbacks: [SECRET],
      },
    ]);
    const output = extractAgentOutput({
      success: true,
      completed: true,
      message: "done",
      output: { answer: "42" },
      actions: [
        {
          type: "act",
          taskCompleted: true,
          timeMs: 12,
          reasoning: SECRET,
          selector: SECRET,
        },
      ],
      messages: [{ content: SECRET }],
      metadata: { debugUrl: SECRET },
    });
    expect(input).toMatchObject({
      instruction: "research this topic",
      output_schema: expect.objectContaining({ type: "object" }),
    });
    expect(output).toEqual({
      success: true,
      completed: true,
      message: "done",
      output: { answer: "42" },
      actions: [{ type: "act", task_completed: true, time_ms: 12 }],
    });
    expect(JSON.stringify({ input, output })).not.toContain(SECRET);
    expect(
      extractAgentMetrics({
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          reasoning_tokens: 2,
          cached_input_tokens: 3,
          inference_time_ms: 900,
        },
      }),
    ).toEqual({
      prompt_tokens: 10,
      completion_tokens: 4,
      tokens: 14,
      completion_reasoning_tokens: 2,
      prompt_cached_tokens: 3,
    });
  });
});
