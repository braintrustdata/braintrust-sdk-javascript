import { debugLogger } from "./debug-logger";
import { openAIChannels } from "./instrumentation/plugins/openai-channels";
import { resolveUseLegacyUuidIds } from "./id-gen";
import {
  _internalExportParentSynchronously,
  getSpanParentObject,
  newId,
} from "./logger";
import { getCurrentUnixTimestamp } from "./util";
import { SpanComponentsV4 } from "../util/span_identifier_v4";
import type {
  OpenAIAgentsTraceState,
  OpenAIAgentsTraceToken,
  StartOpenAIAgentsTraceArgs,
} from "./openai-agents-api-types";

const TOKEN_PREFIX = "bt-openai-agents-v1:";
const MAX_TOKEN_LENGTH = 1_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateStartArgs(value: unknown): StartOpenAIAgentsTraceArgs {
  if (!isRecord(value)) {
    throw new TypeError(
      "startOpenAIAgentsTrace expected an OpenAI Agents parameters object",
    );
  }
  const agent = value.agent;
  if (agent !== undefined && agent !== null && !isRecord(agent)) {
    throw new TypeError(
      "startOpenAIAgentsTrace expected agent to be an object or null",
    );
  }
  if (
    isRecord(agent) &&
    ((agent.id !== undefined && typeof agent.id !== "string") ||
      (agent.model !== undefined && typeof agent.model !== "string") ||
      (agent.name !== undefined &&
        agent.name !== null &&
        typeof agent.name !== "string"))
  ) {
    throw new TypeError(
      "startOpenAIAgentsTrace received invalid agent identity fields",
    );
  }
  if (value.agent_id !== undefined && typeof value.agent_id !== "string") {
    throw new TypeError(
      "startOpenAIAgentsTrace expected agent_id to be a string",
    );
  }
  if (
    value.metadata !== undefined &&
    value.metadata !== null &&
    !isRecord(value.metadata)
  ) {
    throw new TypeError(
      "startOpenAIAgentsTrace expected metadata to be an object or null",
    );
  }
  return value;
}

function validTraceState(value: unknown): value is OpenAIAgentsTraceState {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.version === 1 &&
    typeof value.root === "string" &&
    value.root.length > 0 &&
    typeof value.rootKey === "string" &&
    value.rootKey.length > 0 &&
    typeof value.rootParent === "string" &&
    value.rootParent.length > 0 &&
    typeof value.ended === "boolean" &&
    typeof value.startTime === "number" &&
    Number.isFinite(value.startTime) &&
    (value.firstTokenAt === undefined ||
      (typeof value.firstTokenAt === "number" &&
        Number.isFinite(value.firstTokenAt))) &&
    Array.isArray(value.eventIds) &&
    value.eventIds.every((eventId) => typeof eventId === "string") &&
    isRecord(value.callItems) &&
    Object.values(value.callItems).every(
      (itemId) => typeof itemId === "string",
    ) &&
    isRecord(value.openTools) &&
    Object.values(value.openTools).every(
      (tool) =>
        isRecord(tool) &&
        typeof tool.itemId === "string" &&
        typeof tool.name === "string" &&
        typeof tool.startTime === "number" &&
        Number.isFinite(tool.startTime) &&
        typeof tool.toolType === "string" &&
        (tool.turnId === undefined || typeof tool.turnId === "string"),
    ) &&
    isRecord(value.subagents) &&
    Object.values(value.subagents).every(
      (subagent) =>
        isRecord(subagent) &&
        typeof subagent.openedAt === "number" &&
        Number.isFinite(subagent.openedAt) &&
        (subagent.closedAt === undefined ||
          (typeof subagent.closedAt === "number" &&
            Number.isFinite(subagent.closedAt))) &&
        (subagent.parentAgentId === undefined ||
          typeof subagent.parentAgentId === "string"),
    ) &&
    isRecord(value.turnSubagents) &&
    Object.values(value.turnSubagents).every(
      (subagentId) => typeof subagentId === "string",
    )
  );
}

function decodeToken(token: string): OpenAIAgentsTraceState | null {
  if (
    typeof token !== "string" ||
    !token.startsWith(TOKEN_PREFIX) ||
    token.length > MAX_TOKEN_LENGTH
  ) {
    throw new TypeError("Invalid OpenAI Agents trace token");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(token.slice(TOKEN_PREFIX.length));
  } catch {
    throw new TypeError("Invalid OpenAI Agents trace token");
  }
  if (!isRecord(decoded) || decoded.version !== 1) {
    throw new TypeError("Invalid OpenAI Agents trace token");
  }
  if (decoded.state === null) {
    return null;
  }
  if (!validTraceState(decoded.state)) {
    throw new TypeError("Invalid OpenAI Agents trace token");
  }
  return decoded.state;
}

function encodeToken(state: OpenAIAgentsTraceState | null): string {
  const token: OpenAIAgentsTraceToken = {
    state,
    version: 1,
  };
  const encoded = `${TOKEN_PREFIX}${JSON.stringify(token)}`;
  if (encoded.length > MAX_TOKEN_LENGTH) {
    throw new RangeError("OpenAI Agents trace token is too large");
  }
  return encoded;
}

function validateEvent(event: unknown): unknown {
  let eventType: unknown;
  try {
    eventType = isRecord(event) ? Reflect.get(event, "type") : undefined;
  } catch {
    eventType = undefined;
  }
  if (typeof eventType !== "string" || eventType.length === 0) {
    throw new TypeError(
      "updateOpenAIAgentsTrace expected an OpenAI Agents event object",
    );
  }
  return event;
}

/**
 * Start a manual trace for one asynchronous OpenAI Agents API turn.
 *
 * This helper performs no OpenAI API requests. Pass it the same `input`,
 * `agent`, and `agent_id` values used to create or continue the turn. `metadata`
 * is copied to the Braintrust span and can also contain an application
 * correlation ID when the same parameters are sent to OpenAI. The returned
 * token can be persisted immediately before submission and passed with later events to
 * `updateOpenAIAgentsTrace`. The trace closes when a root turn reaches a
 * terminal state.
 */
export function startOpenAIAgentsTrace(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Provider types vary between OpenAI SDK versions; validate the narrow surface at runtime.
  args: any,
): string {
  const validatedArgs = validateStartArgs(args);
  const parent = _internalExportParentSynchronously(getSpanParentObject());
  if (!parent) {
    return encodeToken(null);
  }
  const parentComponents = SpanComponentsV4.fromStr(parent);
  const rowId = newId();
  const useLegacyIds = resolveUseLegacyUuidIds();
  const spanId = useLegacyIds
    ? newId()
    : newId().replaceAll("-", "").slice(0, 16);
  const rootSpanId = useLegacyIds ? spanId : newId().replaceAll("-", "");
  const root = new SpanComponentsV4({
    object_type: parentComponents.data.object_type,
    ...(parentComponents.data.object_id
      ? { object_id: parentComponents.data.object_id }
      : {
          compute_object_metadata_args:
            parentComponents.data.compute_object_metadata_args ?? {},
        }),
    propagated_event: parentComponents.data.propagated_event,
    root_span_id: rootSpanId,
    row_id: rowId,
    span_id: spanId,
  }).toStr();
  const state: OpenAIAgentsTraceState = {
    callItems: {},
    ended: false,
    eventIds: [],
    openTools: {},
    root,
    rootKey: spanId,
    rootParent: parent,
    startTime: getCurrentUnixTimestamp(),
    subagents: {},
    turnSubagents: {},
    version: 1,
  };
  try {
    void openAIChannels.agentsTraceStart
      .invoke(
        async () => state,
        undefined,
        [{ args: validatedArgs, state }],
        {},
      )
      .catch((error) => {
        debugLogger.debug(
          "OpenAI Agents API instrumentation could not start:",
          error,
        );
      });
  } catch (error) {
    debugLogger.debug(
      "OpenAI Agents API instrumentation could not start:",
      error,
    );
  }
  return encodeToken(state);
}

/**
 * Apply an OpenAI Agents event to a trace and return its next resumable token.
 *
 * This helper performs no OpenAI API requests. It is intended for stream,
 * webhook, and worker processes that observe events from a turn. Events should
 * be applied in order, passing the returned token to the next call.
 */
export async function updateOpenAIAgentsTrace(
  token: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Provider event types vary between OpenAI SDK versions; validate the narrow surface at runtime.
  event: any,
): Promise<string> {
  const state = decodeToken(token);
  const validatedEvent = validateEvent(event);
  try {
    return encodeToken(
      await openAIChannels.agentsTraceCapture.invoke(
        async () => state,
        undefined,
        [{ state, event: validatedEvent }],
        {},
      ),
    );
  } catch (error) {
    debugLogger.debug(
      "OpenAI Agents API instrumentation could not update:",
      error,
    );
    return token;
  }
}

/**
 * End a manual OpenAI Agents API trace after submission or observation fails.
 *
 * This helper performs no OpenAI API requests. It returns a terminal token so
 * repeated delivery can remain idempotent.
 */
export async function failOpenAIAgentsTrace(
  token: string,
  error: unknown,
): Promise<string> {
  const state = decodeToken(token);
  try {
    return encodeToken(
      await openAIChannels.agentsTraceFail.invoke(
        async () => state,
        undefined,
        [{ state, error }],
        {},
      ),
    );
  } catch (instrumentationError) {
    debugLogger.debug(
      "OpenAI Agents API instrumentation could not record failure:",
      instrumentationError,
    );
    return token;
  }
}
