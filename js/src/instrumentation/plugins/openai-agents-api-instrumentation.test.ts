import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  _exportsForTestingOnly,
  initLogger,
  startSpan,
  withCurrent,
} from "../../logger";
import { configureNode } from "../../node/config";
import {
  failOpenAIAgentsTrace,
  startOpenAIAgentsTrace,
  updateOpenAIAgentsTrace,
} from "../../openai-agents-api";
import { OpenAIPlugin } from "./openai-plugin";

try {
  configureNode();
} catch {
  // Best-effort initialization for test environments.
}

describe("OpenAI Agents API instrumentation", () => {
  let backgroundLogger: ReturnType<
    typeof _exportsForTestingOnly.useTestBackgroundLogger
  >;
  let plugin: OpenAIPlugin;

  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
  });

  beforeEach(() => {
    backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({
      projectName: "openai-agents-api-instrumentation.test.ts",
      projectId: "test-project-id",
    });
    plugin = new OpenAIPlugin();
    plugin.enable();
  });

  afterEach(() => {
    plugin.disable();
    _exportsForTestingOnly.clearTestBackgroundLogger();
  });

  it("captures a resumable turn and correlates function results", async () => {
    let token = startOpenAIAgentsTrace({
      input: "What is the weather in Vienna?",
      agent: { model: "gpt-test", tools: [{ name: "lookup_weather" }] },
      metadata: { tenant: "test" },
    });
    token = await updateOpenAIAgentsTrace(token, {
      event_id: "evt-session",
      session: {
        id: "sess-1",
        agent: { id: "agent-1", model: "gpt-test", name: "Weather" },
      },
      type: "agent.session.created",
    });
    token = await updateOpenAIAgentsTrace(token, {
      event_id: "evt-turn",
      session_id: "sess-1",
      turn: {
        id: "turn-1",
        created_at: 100,
        subagent_id: null,
      },
      turn_id: "turn-1",
      type: "agent.session.turn.created",
    });
    token = await updateOpenAIAgentsTrace(token, {
      event_id: "evt-function",
      item: {
        id: "item-function",
        arguments: { city: "Vienna" },
        call_id: "call-1",
        name: "lookup_weather",
        status: "completed",
        turn_id: "turn-1",
        type: "function_call",
      },
      type: "agent.session.turn.item.done",
    });
    token = await updateOpenAIAgentsTrace(token, {
      delta: "streamed answer text",
      event_id: "evt-first-token",
      type: "agent.session.turn.output_text.delta",
    });

    expect(token).not.toContain("streamed answer text");
    token = await updateOpenAIAgentsTrace(token, {
      event_id: "evt-result",
      item: {
        id: "item-result",
        call_id: "call-1",
        error: null,
        output: "Sunny in Vienna",
        status: "completed",
        turn_id: "turn-1",
        type: "function_call_output",
      },
      type: "agent.session.turn.item.added",
    });
    token = await updateOpenAIAgentsTrace(token, {
      event_id: "evt-answer",
      item: {
        id: "item-answer",
        content: [{ type: "output_text", text: "It is sunny." }],
        phase: "final_answer",
        role: "assistant",
        status: "completed",
        turn_id: "turn-1",
        type: "message",
      },
      type: "agent.session.turn.item.done",
    });
    const completed = {
      event_id: "evt-completed",
      session_id: "sess-1",
      turn: {
        id: "turn-1",
        completed_at: 200,
        error: null,
        subagent_id: null,
      },
      turn_id: "turn-1",
      type: "agent.session.turn.completed",
      usage: {
        input_tokens: 10,
        input_tokens_details: { cached_tokens: 3 },
        output_tokens: 4,
        output_tokens_details: { reasoning_tokens: 1 },
        total_tokens: 14,
      },
    };
    token = await updateOpenAIAgentsTrace(token, completed);
    token = await updateOpenAIAgentsTrace(token, completed);
    expect(token).toEqual(expect.any(String));

    const rows = (await backgroundLogger.drain()) as Array<Record<string, any>>;
    expect(rows).toHaveLength(2);
    const root = rows.find(
      (row) => row.span_attributes?.name === "openai.agents.turn",
    );
    const tool = rows.find(
      (row) => row.span_attributes?.name === "lookup_weather",
    );
    expect(root).toMatchObject({
      input: "What is the weather in Vienna?",
      metadata: {
        agent_id: "agent-1",
        agent_name: "Weather",
        api: "agents",
        model: "gpt-test",
        provider: "openai",
        session_id: "sess-1",
        tenant: "test",
      },
      metrics: {
        completion_reasoning_tokens: 1,
        completion_tokens: 4,
        end: 200,
        prompt_cached_tokens: 3,
        prompt_tokens: 10,
        time_to_first_token: expect.any(Number),
        tokens: 14,
      },
      output: "It is sunny.",
      span_attributes: { type: "task" },
    });
    expect(tool).toMatchObject({
      input: { city: "Vienna" },
      metadata: {
        item_id: "item-function",
        provider: "openai",
        status: "completed",
        tool_type: "function_call",
        turn_id: "turn-1",
      },
      output: "Sunny in Vienna",
      span_attributes: { type: "tool" },
      span_parents: [root?.span_id],
    });
    expect(rows.some((row) => row.span_attributes?.type === "llm")).toBe(false);
  });

  it("nests subagent tools under a subagent task", async () => {
    let token = startOpenAIAgentsTrace({
      input: "Delegate this research",
      agent: { id: "root-agent", model: "gpt-test" },
    });
    token = await updateOpenAIAgentsTrace(token, {
      event_id: "evt-subagent",
      subagent: {
        id: "subagent-1",
        instructions: [{ type: "output_text", text: "Research Vienna" }],
        name: "Researcher",
        opened_at: 110,
        parent_agent_id: "root-agent",
        status: "active",
      },
      type: "agent.session.subagent.created",
    });
    token = await updateOpenAIAgentsTrace(token, {
      event_id: "evt-sub-turn",
      session_id: "sess-2",
      turn: {
        id: "turn-sub",
        created_at: 111,
        subagent_id: "subagent-1",
      },
      turn_id: "turn-sub",
      type: "agent.session.turn.created",
    });
    token = await updateOpenAIAgentsTrace(token, {
      event_id: "evt-mcp-added",
      item: {
        id: "item-mcp",
        arguments: { city: "Vienna" },
        name: "search",
        server_label: "maps",
        status: "in_progress",
        turn_id: "turn-sub",
        type: "mcp_call",
      },
      type: "agent.session.turn.item.added",
    });
    token = await updateOpenAIAgentsTrace(token, {
      event_id: "evt-mcp-done",
      item: {
        id: "item-mcp",
        arguments: { city: "Vienna" },
        error: null,
        name: "search",
        output: { result: "Vienna" },
        server_label: "maps",
        status: "completed",
        turn_id: "turn-sub",
        type: "mcp_call",
      },
      type: "agent.session.turn.item.done",
    });
    token = await updateOpenAIAgentsTrace(token, {
      event_id: "evt-sub-closed",
      subagent: {
        id: "subagent-1",
        closed_at: 140,
        name: "Researcher",
        opened_at: 110,
        parent_agent_id: "root-agent",
        status: "closed",
      },
      type: "agent.session.subagent.closed",
    });
    token = await updateOpenAIAgentsTrace(token, {
      event_id: "evt-root-completed",
      session_id: "sess-2",
      turn: {
        id: "turn-root",
        completed_at: 150,
        subagent_id: null,
      },
      turn_id: "turn-root",
      type: "agent.session.turn.completed",
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
    });
    expect(token).toEqual(expect.any(String));

    const rows = (await backgroundLogger.drain()) as Array<Record<string, any>>;
    const root = rows.find(
      (row) => row.span_attributes?.name === "openai.agents.turn",
    );
    const subagent = rows.find(
      (row) => row.span_attributes?.name === "openai.agents.subagent",
    );
    const tool = rows.find(
      (row) => row.span_attributes?.name === "maps.search",
    );
    expect(subagent).toMatchObject({
      input: [{ type: "output_text", text: "Research Vienna" }],
      metadata: {
        agent_id: "subagent-1",
        agent_name: "Researcher",
        parent_agent_id: "root-agent",
      },
      metrics: { end: 140, start: 110 },
      span_attributes: { type: "task" },
      span_parents: [root?.span_id],
    });
    expect(tool).toMatchObject({
      input: { city: "Vienna" },
      output: { result: "Vienna" },
      span_attributes: { type: "tool" },
      span_parents: [subagent?.span_id],
    });
  });

  it("closes open work on explicit failure and rejects invalid tokens", async () => {
    let token = startOpenAIAgentsTrace({ input: "fail" });
    token = await updateOpenAIAgentsTrace(token, {
      event_id: "evt-command",
      item: {
        id: "item-command",
        command: "exit 1",
        cwd: "/workspace",
        status: "in_progress",
        turn_id: "turn-fail",
        type: "command_execution",
      },
      type: "agent.session.turn.item.added",
    });
    token = await failOpenAIAgentsTrace(token, new Error("network failed"));
    token = await failOpenAIAgentsTrace(token, new Error("duplicate failure"));

    const rows = (await backgroundLogger.drain()) as Array<Record<string, any>>;
    expect(rows).toHaveLength(2);
    expect(
      rows.find((row) => row.span_attributes?.name === "openai.agents.turn")
        ?.error,
    ).toContain("network failed");
    expect(
      rows.find((row) => row.span_attributes?.name === "Command execution")
        ?.error,
    ).toContain("network failed");
    await expect(
      updateOpenAIAgentsTrace("invalid", { type: "agent.session.created" }),
    ).rejects.toThrow("Invalid OpenAI Agents trace token");
  });

  it("preserves the active Braintrust span as its parent", async () => {
    const parent = startSpan({ name: "parent" });
    let token = withCurrent(parent, () =>
      startOpenAIAgentsTrace({ input: "hello" }),
    );
    token = await updateOpenAIAgentsTrace(token, {
      event_id: "evt-completed",
      turn: { completed_at: 200, id: "turn-1", subagent_id: null },
      type: "agent.session.turn.completed",
    });
    expect(token).toEqual(expect.any(String));
    parent.end();

    const rows = (await backgroundLogger.drain()) as Array<Record<string, any>>;
    const parentRow = rows.find(
      (row) => row.span_attributes?.name === "parent",
    );
    const root = rows.find(
      (row) => row.span_attributes?.name === "openai.agents.turn",
    );
    expect(root?.span_parents).toEqual([parentRow?.span_id]);
    expect(root?.root_span_id).toBe(parentRow?.root_span_id);
  });

  it("validates broadly typed start and update arguments at runtime", async () => {
    expect(() => startOpenAIAgentsTrace(null)).toThrow(
      "expected an OpenAI Agents parameters object",
    );
    expect(() =>
      startOpenAIAgentsTrace({ agent: "not-an-agent-object" }),
    ).toThrow("expected agent to be an object or null");
    expect(() => startOpenAIAgentsTrace({ agent: { model: 42 } })).toThrow(
      "invalid agent identity fields",
    );
    expect(() =>
      startOpenAIAgentsTrace({ agent_id: { id: "agent-1" } }),
    ).toThrow("expected agent_id to be a string");
    expect(() =>
      startOpenAIAgentsTrace({ metadata: ["not", "metadata"] }),
    ).toThrow("expected metadata to be an object or null");
    let token = startOpenAIAgentsTrace({
      agent: { future_agent_field: true, model: "gpt-test" },
      future_session_field: { supported: true },
      input: [{ future_input_type: "provider-version-specific" }],
    });
    expect(token).toEqual(expect.any(String));
    await expect(updateOpenAIAgentsTrace(token, null)).rejects.toThrow(
      "expected an OpenAI Agents event object",
    );
    await expect(updateOpenAIAgentsTrace(token, { type: 42 })).rejects.toThrow(
      "expected an OpenAI Agents event object",
    );
    await expect(updateOpenAIAgentsTrace(token, { type: "" })).rejects.toThrow(
      "expected an OpenAI Agents event object",
    );
    token = await updateOpenAIAgentsTrace(token, {
      future_event_field: { supported: true },
      type: "agent.session.future_event",
    });
    token = await failOpenAIAgentsTrace(token, new Error("done"));
    expect(token).toEqual(expect.any(String));

    const rows = (await backgroundLogger.drain()) as Array<Record<string, any>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      input: [{ future_input_type: "provider-version-specific" }],
      metadata: { model: "gpt-test", provider: "openai" },
    });
  });
});
