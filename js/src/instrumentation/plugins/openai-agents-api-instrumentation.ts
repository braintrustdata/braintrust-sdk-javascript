import { debugLogger } from "../../debug-logger";
import {
  _internalStartSpanWithInitialMerge,
  _internalStartSpanWithInitialMergeAndParentSpanIds,
  NOOP_SPAN,
  type Span,
  withCurrent,
} from "../../logger";
import type {
  OpenAIAgentsOpenTool,
  OpenAIAgentsTraceState,
  StartOpenAIAgentsTraceArgs,
} from "../../openai-agents-api-types";
import { parseMetricsFromUsage } from "../../openai-utils";
import {
  INSTRUMENTATION_NAMES,
  withSpanInstrumentationName,
} from "../../span-origin";
import { getCurrentUnixTimestamp } from "../../util";
import { isObject, SpanTypeAttribute } from "../../../util/index";
import { SpanComponentsV4 } from "../../../util/span_identifier_v4";
import { openAIChannels } from "./openai-channels";
import {
  deterministicDigest,
  digestHex,
  digestUuid,
} from "./openai-manual-instrumentation-utils";

const TERMINAL_TURN_EVENTS = new Set([
  "agent.session.turn.completed",
  "agent.session.turn.failed",
  "agent.session.turn.cancelled",
]);

const TURN_LIFECYCLE_EVENTS = new Set([
  "agent.session.turn.created",
  "agent.session.turn.in_progress",
  ...TERMINAL_TURN_EVENTS,
]);

const SESSION_EVENTS = new Set([
  "agent.session.created",
  "agent.session.failed",
  "agent.session.idle",
  "agent.session.in_progress",
  "agent.session.requires_action",
]);

const SUBAGENT_EVENTS = new Set([
  "agent.session.subagent.active",
  "agent.session.subagent.closed",
  "agent.session.subagent.created",
]);

function read(value: unknown, key: PropertyKey): unknown {
  if (!isObject(value)) {
    return undefined;
  }
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function recordValue<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function setRecordValue<T>(record: Record<string, T>, key: string, value: T) {
  Object.defineProperty(record, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function loggedError(value: unknown, fallback: string): Error {
  if (value instanceof Error) {
    return value;
  }
  const message = stringValue(read(value, "message"));
  return new Error(message ?? (typeof value === "string" ? value : fallback));
}

function logInstrumentationError(context: string, error: unknown): void {
  debugLogger.debug(`OpenAI Agents API instrumentation ${context}:`, error);
}

async function childSpanIds(
  rootKey: string,
  kind: string,
  providerId: string,
): Promise<{ rowId: string; spanId: string }> {
  const [row, span] = await Promise.all([
    deterministicDigest("openai:agents:row", rootKey, kind, providerId),
    deterministicDigest("openai:agents:span", rootKey, kind, providerId),
  ]);
  return { rowId: digestUuid(row), spanId: digestHex(span, 8) };
}

function traceMetadata(args: StartOpenAIAgentsTraceArgs) {
  const metadata: Record<string, unknown> = {};
  const suppliedMetadata = read(args, "metadata");
  if (isObject(suppliedMetadata)) {
    try {
      for (const key of Object.keys(suppliedMetadata)) {
        metadata[key] = read(suppliedMetadata, key);
      }
    } catch (error) {
      logInstrumentationError("could not read supplied metadata", error);
    }
  }
  const agent = read(args, "agent");
  const agentId =
    stringValue(read(agent, "id")) ?? stringValue(read(args, "agent_id"));
  const agentName = stringValue(read(agent, "name"));
  const model = stringValue(read(agent, "model"));
  return {
    ...metadata,
    api: "agents",
    ...(agentId ? { agent_id: agentId } : {}),
    ...(agentName ? { agent_name: agentName } : {}),
    ...(model ? { model } : {}),
    provider: "openai",
  };
}

function copyState(state: OpenAIAgentsTraceState): OpenAIAgentsTraceState {
  return {
    ...state,
    callItems: { ...state.callItems },
    eventIds: [...state.eventIds],
    openTools: { ...state.openTools },
    subagents: { ...state.subagents },
    turnSubagents: { ...state.turnSubagents },
  };
}

function startRootSpan(state: OpenAIAgentsTraceState): Span {
  const root = SpanComponentsV4.fromStr(state.root);
  const parent = SpanComponentsV4.fromStr(state.rootParent);
  const rowId = stringValue(root.data.row_id);
  const rootSpanId = stringValue(root.data.root_span_id);
  const spanId = stringValue(root.data.span_id);
  if (!rowId || !rootSpanId || !spanId) {
    throw new Error("OpenAI Agents trace root is invalid");
  }
  const hasParentSpan = Boolean(
    parent.data.row_id && parent.data.span_id && parent.data.root_span_id,
  );
  return withCurrent(NOOP_SPAN, () =>
    _internalStartSpanWithInitialMergeAndParentSpanIds(
      withSpanInstrumentationName(
        {
          name: "openai.agents.turn",
          type: SpanTypeAttribute.TASK,
          parent: state.rootParent,
          ...(!hasParentSpan
            ? {
                parentSpanIds: {
                  parentSpanIds: [],
                  rootSpanId,
                },
              }
            : {}),
          spanId,
          startTime: state.startTime,
          event: { id: rowId },
        },
        INSTRUMENTATION_NAMES.OPENAI,
      ),
    ),
  );
}

async function startSubagentSpan(
  state: OpenAIAgentsTraceState,
  subagentId: string,
  input?: unknown,
  metadata?: Record<string, unknown>,
  visiting = new Set<string>(),
): Promise<Span> {
  const subagent = recordValue(state.subagents, subagentId);
  let parent = state.root;
  if (
    subagent?.parentAgentId &&
    subagent.parentAgentId !== subagentId &&
    recordValue(state.subagents, subagent.parentAgentId) &&
    !visiting.has(subagent.parentAgentId)
  ) {
    visiting.add(subagentId);
    parent = await (
      await startSubagentSpan(
        state,
        subagent.parentAgentId,
        undefined,
        undefined,
        visiting,
      )
    ).export();
  }
  const ids = await childSpanIds(state.rootKey, "subagent", subagentId);
  return withCurrent(NOOP_SPAN, () =>
    _internalStartSpanWithInitialMerge(
      withSpanInstrumentationName(
        {
          name: "openai.agents.subagent",
          type: SpanTypeAttribute.TASK,
          parent,
          spanId: ids.spanId,
          startTime: subagent?.openedAt,
          event: {
            id: ids.rowId,
            ...(input !== undefined ? { input } : {}),
            metadata: {
              ...metadata,
              agent_id: subagentId,
              ...(subagent?.parentAgentId
                ? { parent_agent_id: subagent.parentAgentId }
                : {}),
              provider: "openai",
            },
          },
        },
        INSTRUMENTATION_NAMES.OPENAI,
      ),
    ),
  );
}

async function parentForTurn(
  state: OpenAIAgentsTraceState,
  turnId: string | undefined,
): Promise<string> {
  const subagentId = turnId
    ? recordValue(state.turnSubagents, turnId)
    : undefined;
  if (!subagentId) {
    return state.root;
  }
  return await (await startSubagentSpan(state, subagentId)).export();
}

async function startToolSpan(
  state: OpenAIAgentsTraceState,
  tool: OpenAIAgentsOpenTool,
  input?: unknown,
): Promise<Span> {
  const ids = await childSpanIds(state.rootKey, "tool", tool.itemId);
  return withCurrent(NOOP_SPAN, async () =>
    _internalStartSpanWithInitialMerge(
      withSpanInstrumentationName(
        {
          name: tool.name,
          type: SpanTypeAttribute.TOOL,
          parent: await parentForTurn(state, tool.turnId),
          spanId: ids.spanId,
          startTime: tool.startTime,
          event: {
            id: ids.rowId,
            ...(input !== undefined ? { input } : {}),
            metadata: {
              item_id: tool.itemId,
              provider: "openai",
              tool_type: tool.toolType,
              ...(tool.turnId ? { turn_id: tool.turnId } : {}),
            },
          },
        },
        INSTRUMENTATION_NAMES.OPENAI,
      ),
    ),
  );
}

function toolFromItem(
  item: unknown,
  observedAt: number,
): { input?: unknown; tool: OpenAIAgentsOpenTool } | undefined {
  const itemId = stringValue(read(item, "id"));
  const toolType = stringValue(read(item, "type"));
  if (!itemId || !toolType) {
    return undefined;
  }
  const turnId = stringValue(read(item, "turn_id"));
  switch (toolType) {
    case "function_call":
      return {
        input: read(item, "arguments"),
        tool: {
          itemId,
          name: stringValue(read(item, "name")) ?? "Function call",
          startTime: observedAt,
          toolType,
          ...(turnId ? { turnId } : {}),
        },
      };
    case "mcp_call": {
      const name = stringValue(read(item, "name")) ?? "MCP call";
      const server = stringValue(read(item, "server_label"));
      return {
        input: read(item, "arguments"),
        tool: {
          itemId,
          name: server ? `${server}.${name}` : name,
          startTime: observedAt,
          toolType,
          ...(turnId ? { turnId } : {}),
        },
      };
    }
    case "web_search_call":
      return {
        input: read(item, "action"),
        tool: {
          itemId,
          name: "Web search",
          startTime: observedAt,
          toolType,
          ...(turnId ? { turnId } : {}),
        },
      };
    case "command_execution":
      return {
        input: {
          command: read(item, "command"),
          cwd: read(item, "cwd"),
        },
        tool: {
          itemId,
          name: "Command execution",
          startTime: observedAt,
          toolType,
          ...(turnId ? { turnId } : {}),
        },
      };
    default:
      return undefined;
  }
}

function textFromContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text: string[] = [];
  for (const part of content) {
    const partText = read(part, "text");
    if (read(part, "type") === "output_text" && typeof partText === "string") {
      text.push(partText);
    }
  }
  return text.length > 0 ? text.join("") : undefined;
}

function toolOutput(item: unknown, toolType: string): unknown {
  switch (toolType) {
    case "function_call":
      return read(item, "output");
    case "mcp_call":
      return read(item, "output");
    case "web_search_call":
      return read(item, "action");
    case "command_execution":
      return read(item, "output");
    default:
      return undefined;
  }
}

function toolFailed(item: unknown, toolType: string): Error | undefined {
  const status = read(item, "status");
  const explicitError = read(item, "error");
  if (explicitError !== undefined && explicitError !== null) {
    return loggedError(explicitError, `OpenAI ${toolType} failed`);
  }
  if (status === "failed" || status === "incomplete") {
    return new Error(`OpenAI ${toolType} ${status}`);
  }
  if (
    toolType === "command_execution" &&
    typeof read(item, "exit_code") === "number" &&
    read(item, "exit_code") !== 0
  ) {
    return new Error(
      `OpenAI command exited with code ${read(item, "exit_code")}`,
    );
  }
  return undefined;
}

async function completeTool(
  state: OpenAIAgentsTraceState,
  tool: OpenAIAgentsOpenTool,
  item: unknown,
  endTime: number,
): Promise<void> {
  const span = await startToolSpan(state, tool);
  const output = toolOutput(item, tool.toolType);
  const error = toolFailed(item, tool.toolType);
  span.log({
    ...(output !== undefined ? { output } : {}),
    ...(error ? { error } : {}),
    metadata: {
      status: read(item, "status"),
      ...(tool.toolType === "command_execution"
        ? { exit_code: read(item, "exit_code") }
        : {}),
    },
  });
  span.end({ endTime });
  Reflect.deleteProperty(state.openTools, tool.itemId);
}

async function captureMessage(
  state: OpenAIAgentsTraceState,
  item: unknown,
): Promise<void> {
  if (
    read(item, "type") !== "message" ||
    read(item, "role") !== "assistant" ||
    read(item, "phase") !== "final_answer"
  ) {
    return;
  }
  const output = textFromContent(read(item, "content"));
  if (output === undefined) {
    return;
  }
  const turnId = stringValue(read(item, "turn_id"));
  const subagentId = turnId
    ? recordValue(state.turnSubagents, turnId)
    : undefined;
  if (subagentId) {
    (await startSubagentSpan(state, subagentId)).log({ output });
  } else {
    startRootSpan(state).log({ output });
  }
}

async function captureItem(
  state: OpenAIAgentsTraceState,
  item: unknown,
  isDone: boolean,
  observedAt: number,
): Promise<void> {
  await captureMessage(state, item);
  const itemType = stringValue(read(item, "type"));
  if (itemType === "function_call_output") {
    const callId = stringValue(read(item, "call_id"));
    const itemId = callId ? recordValue(state.callItems, callId) : undefined;
    const tool = itemId ? recordValue(state.openTools, itemId) : undefined;
    if (tool) {
      await completeTool(state, tool, item, observedAt);
    }
    return;
  }

  const descriptor = toolFromItem(item, observedAt);
  if (!descriptor) {
    return;
  }
  const existing = recordValue(state.openTools, descriptor.tool.itemId);
  const tool = existing ?? descriptor.tool;
  setRecordValue(state.openTools, tool.itemId, tool);
  if (itemType === "function_call") {
    const callId = stringValue(read(item, "call_id"));
    if (callId) {
      setRecordValue(state.callItems, callId, tool.itemId);
    }
  }
  await startToolSpan(state, tool, descriptor.input);
  const status = read(item, "status");
  const terminalFunctionCall =
    itemType === "function_call" &&
    (status === "failed" || status === "incomplete");
  if (
    (itemType !== "function_call" && (isDone || status !== "in_progress")) ||
    terminalFunctionCall
  ) {
    await completeTool(state, tool, item, observedAt);
  }
}

function updateSessionMetadata(
  state: OpenAIAgentsTraceState,
  session: unknown,
): void {
  const sessionId = stringValue(read(session, "id"));
  const agent = read(session, "agent");
  startRootSpan(state).log({
    metadata: {
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(stringValue(read(agent, "id"))
        ? { agent_id: read(agent, "id") }
        : {}),
      ...(stringValue(read(agent, "name"))
        ? { agent_name: read(agent, "name") }
        : {}),
      ...(stringValue(read(agent, "model"))
        ? { model: read(agent, "model") }
        : {}),
    },
  });
}

async function captureSubagent(
  state: OpenAIAgentsTraceState,
  eventType: string,
  subagent: unknown,
  observedAt: number,
): Promise<void> {
  const subagentId = stringValue(read(subagent, "id"));
  if (!subagentId) {
    return;
  }
  const existing = recordValue(state.subagents, subagentId);
  const observedOpenedAt = read(subagent, "opened_at");
  const openedAt =
    typeof observedOpenedAt === "number" &&
    Number.isFinite(observedOpenedAt) &&
    observedOpenedAt >= 0
      ? observedOpenedAt
      : (existing?.openedAt ?? observedAt);
  const observedClosedAt = read(subagent, "closed_at");
  const closedAt =
    typeof observedClosedAt === "number" &&
    Number.isFinite(observedClosedAt) &&
    observedClosedAt >= 0
      ? observedClosedAt
      : existing?.closedAt;
  const parentAgentId =
    stringValue(read(subagent, "parent_agent_id")) ?? existing?.parentAgentId;
  setRecordValue(state.subagents, subagentId, {
    ...(closedAt !== undefined ? { closedAt } : {}),
    openedAt,
    ...(parentAgentId ? { parentAgentId } : {}),
  });
  const span = await startSubagentSpan(
    state,
    subagentId,
    read(subagent, "instructions"),
    {
      ...(stringValue(read(subagent, "name"))
        ? { agent_name: read(subagent, "name") }
        : {}),
      status: read(subagent, "status"),
    },
  );
  if (eventType === "agent.session.subagent.closed") {
    span.end({ endTime: closedAt ?? observedAt });
  }
}

async function closeTrace(
  state: OpenAIAgentsTraceState,
  endTime: number,
  error?: Error,
  usage?: unknown,
): Promise<void> {
  if (state.ended) {
    return;
  }
  for (const tool of Object.values(state.openTools)) {
    const span = await startToolSpan(state, tool);
    span.log({
      error:
        error ?? new Error("OpenAI Agents turn ended before tool completion"),
    });
    span.end({ endTime });
  }
  state.openTools = {};
  for (const subagentId of Object.keys(state.subagents)) {
    const subagent = state.subagents[subagentId];
    const span = await startSubagentSpan(state, subagentId);
    span.end({ endTime: subagent.closedAt ?? endTime });
  }
  const root = startRootSpan(state);
  root.log({
    ...(error ? { error } : {}),
    metrics: parseMetricsFromUsage(usage),
  });
  root.end({ endTime });
  state.ended = true;
}

async function captureTurnLifecycle(
  state: OpenAIAgentsTraceState,
  event: unknown,
  eventType: string,
  observedAt: number,
): Promise<void> {
  const turn = read(event, "turn");
  const turnId =
    stringValue(read(event, "turn_id")) ?? stringValue(read(turn, "id"));
  const subagentId = stringValue(read(turn, "subagent_id"));
  if (turnId && subagentId) {
    setRecordValue(state.turnSubagents, turnId, subagentId);
    if (!recordValue(state.subagents, subagentId)) {
      const createdAt = read(turn, "created_at");
      setRecordValue(state.subagents, subagentId, {
        openedAt:
          typeof createdAt === "number" &&
          Number.isFinite(createdAt) &&
          createdAt >= 0
            ? createdAt
            : observedAt,
      });
    }
    await startSubagentSpan(state, subagentId);
  }
  const sessionId = stringValue(read(event, "session_id"));
  if (sessionId) {
    startRootSpan(state).log({ metadata: { session_id: sessionId } });
  }
  if (!TERMINAL_TURN_EVENTS.has(eventType) || subagentId) {
    if (subagentId && eventType === "agent.session.turn.failed") {
      (await startSubagentSpan(state, subagentId)).log({
        error: loggedError(read(turn, "error"), "OpenAI subagent turn failed"),
      });
    }
    return;
  }
  const completedAt = read(turn, "completed_at");
  const endTime =
    typeof completedAt === "number" &&
    Number.isFinite(completedAt) &&
    completedAt >= 0
      ? completedAt
      : observedAt;
  const usage = read(event, "usage") ?? read(turn, "usage");
  const error =
    eventType === "agent.session.turn.completed"
      ? undefined
      : loggedError(
          read(turn, "error"),
          eventType === "agent.session.turn.cancelled"
            ? "OpenAI Agents turn cancelled"
            : "OpenAI Agents turn failed",
        );
  await closeTrace(state, endTime, error, usage);
}

async function captureEvent(
  state: OpenAIAgentsTraceState,
  event: unknown,
): Promise<OpenAIAgentsTraceState> {
  if (state.ended) {
    return state;
  }
  const eventType = stringValue(read(event, "type"));
  const eventId = stringValue(read(event, "event_id"));
  if (!eventType || (eventId && state.eventIds.includes(eventId))) {
    return state;
  }
  const next = copyState(state);
  const observedAt = getCurrentUnixTimestamp();
  let handled = false;
  if (SESSION_EVENTS.has(eventType)) {
    const session = read(event, "session");
    if (session) {
      updateSessionMetadata(next, session);
    }
    handled = true;
  }
  if (eventType === "agent.session.turn.item.added") {
    await captureItem(next, read(event, "item"), false, observedAt);
    handled = true;
  } else if (eventType === "agent.session.turn.item.done") {
    await captureItem(next, read(event, "item"), true, observedAt);
    handled = true;
  } else if (TURN_LIFECYCLE_EVENTS.has(eventType)) {
    await captureTurnLifecycle(next, event, eventType, observedAt);
    handled = true;
  } else if (SUBAGENT_EVENTS.has(eventType)) {
    await captureSubagent(next, eventType, read(event, "subagent"), observedAt);
    handled = true;
  } else if (
    eventType === "agent.session.turn.output_text.delta" &&
    next.firstTokenAt === undefined &&
    stringValue(read(event, "delta"))
  ) {
    next.firstTokenAt = observedAt;
    startRootSpan(next).log({
      metrics: { time_to_first_token: observedAt - next.startTime },
    });
    handled = true;
  } else if (eventType === "agent.session.failed") {
    const session = read(event, "session");
    const lastActiveAt = read(session, "last_active_at");
    const endTime =
      typeof lastActiveAt === "number" &&
      Number.isFinite(lastActiveAt) &&
      lastActiveAt >= 0
        ? lastActiveAt
        : observedAt;
    await closeTrace(
      next,
      endTime,
      loggedError(read(session, "error"), "OpenAI Agents session failed"),
      read(session, "usage"),
    );
    handled = true;
  } else if (eventType === "error") {
    await closeTrace(
      next,
      observedAt,
      loggedError(read(event, "error"), "OpenAI Agents session failed"),
    );
    handled = true;
  }
  if (!handled) {
    return state;
  }
  if (eventId) {
    next.eventIds.push(eventId);
  }
  return next;
}

export const interceptOpenAIAgentsTraceStart: Parameters<
  typeof openAIChannels.agentsTraceStart.intercept
>[0] = async (target, thisArg, args) => {
  const fallback = await Reflect.apply(target, thisArg, args);
  try {
    const state = args[0].state;
    const parent = state.rootParent;
    const traceArgs = args[0].args;
    const parentComponents = SpanComponentsV4.fromStr(parent);
    const hasParentSpan = Boolean(
      parentComponents.data.row_id &&
      parentComponents.data.span_id &&
      parentComponents.data.root_span_id,
    );
    const rootComponents = SpanComponentsV4.fromStr(state.root);
    const rowId = stringValue(rootComponents.data.row_id);
    const rootSpanId = stringValue(rootComponents.data.root_span_id);
    const spanId = stringValue(rootComponents.data.span_id);
    if (!rowId || !rootSpanId || !spanId) {
      throw new Error("OpenAI Agents trace root is invalid");
    }
    withCurrent(NOOP_SPAN, () =>
      _internalStartSpanWithInitialMergeAndParentSpanIds(
        withSpanInstrumentationName(
          {
            name: "openai.agents.turn",
            type: SpanTypeAttribute.TASK,
            parent,
            ...(!hasParentSpan
              ? {
                  parentSpanIds: {
                    parentSpanIds: [],
                    rootSpanId,
                  },
                }
              : {}),
            spanId,
            startTime: state.startTime,
            event: {
              id: rowId,
              input: read(traceArgs, "input"),
              metadata: traceMetadata(traceArgs),
            },
          },
          INSTRUMENTATION_NAMES.OPENAI,
        ),
      ),
    );
    return state;
  } catch (error) {
    logInstrumentationError("could not start trace", error);
    return fallback;
  }
};

export const interceptOpenAIAgentsTraceCapture: Parameters<
  typeof openAIChannels.agentsTraceCapture.intercept
>[0] = async (target, thisArg, args) => {
  const fallback = await Reflect.apply(target, thisArg, args);
  if (!args[0].state) {
    return fallback;
  }
  try {
    return await captureEvent(args[0].state, args[0].event);
  } catch (error) {
    logInstrumentationError("could not capture event", error);
    return fallback;
  }
};

export const interceptOpenAIAgentsTraceFail: Parameters<
  typeof openAIChannels.agentsTraceFail.intercept
>[0] = async (target, thisArg, args) => {
  const fallback = await Reflect.apply(target, thisArg, args);
  if (!args[0].state) {
    return fallback;
  }
  try {
    const next = copyState(args[0].state);
    await closeTrace(
      next,
      getCurrentUnixTimestamp(),
      loggedError(args[0].error, "OpenAI Agents request failed"),
    );
    return next;
  } catch (error) {
    logInstrumentationError("could not fail trace", error);
    return fallback;
  }
};
