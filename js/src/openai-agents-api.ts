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

function validateEvent(event: unknown): unknown {
  if (
    !isRecord(event) ||
    typeof event.type !== "string" ||
    event.type.length === 0
  ) {
    throw new TypeError(
      "updateOpenAIAgentsTrace expected an OpenAI Agents event object",
    );
  }
  return event;
}

function createTraceState(): OpenAIAgentsTraceState | null {
  const parent = _internalExportParentSynchronously(getSpanParentObject());
  if (!parent) {
    return null;
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
  return {
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
): OpenAIAgentsTraceToken {
  const validatedArgs = validateStartArgs(args);
  const state = createTraceState();
  if (!state) {
    return null;
  }
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
  return state;
}

/**
 * Apply an OpenAI Agents event to a trace and return its next resumable token.
 *
 * This helper performs no OpenAI API requests. It is intended for stream,
 * webhook, and worker processes that observe events from a turn. Events should
 * be applied in order, passing the returned token to the next call.
 */
export async function updateOpenAIAgentsTrace(
  token: OpenAIAgentsTraceToken,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Provider event types vary between OpenAI SDK versions; validate the narrow surface at runtime.
  event: any,
): Promise<OpenAIAgentsTraceToken> {
  const state = token;
  const validatedEvent = validateEvent(event);
  try {
    return await openAIChannels.agentsTraceCapture.invoke(
      async () => state,
      undefined,
      [{ state, event: validatedEvent }],
      {},
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
  token: OpenAIAgentsTraceToken,
  error: unknown,
): Promise<OpenAIAgentsTraceToken> {
  const state = token;
  try {
    return await openAIChannels.agentsTraceFail.invoke(
      async () => state,
      undefined,
      [{ state, error }],
      {},
    );
  } catch (instrumentationError) {
    debugLogger.debug(
      "OpenAI Agents API instrumentation could not record failure:",
      instrumentationError,
    );
    return token;
  }
}
