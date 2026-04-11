import { BasePlugin } from "../core";
import type { ChannelMessage } from "../core/channel-definitions";
import { isAsyncIterable, patchStreamIfNeeded } from "../core/stream-patcher";
import type { IsoChannelHandlers } from "../../isomorph";
import { startSpan } from "../../logger";
import type { Span } from "../../logger";
import { SpanTypeAttribute } from "../../../util/index";
import { getCurrentUnixTimestamp } from "../../util";
import { googleADKChannels } from "./google-adk-channels";
import type {
  GoogleADKEvent,
  GoogleADKRunAsyncParams,
  GoogleADKToolRunRequest,
  GoogleADKUsageMetadata,
  GoogleADKBaseAgent,
  GoogleADKLlmAgent,
} from "../../vendor-sdk-types/google-adk";

type RunnerState = {
  span: Span;
  startTime: number;
  events: GoogleADKEvent[];
};

type AgentState = {
  span: Span;
  startTime: number;
  events: GoogleADKEvent[];
};

type ToolState = {
  span: Span;
  startTime: number;
};

/**
 * Auto-instrumentation plugin for the Google ADK.
 *
 * This plugin subscribes to orchestrion channels for Google ADK methods
 * and creates Braintrust spans to track:
 * - Runner.runAsync — top-level agent execution (TASK span)
 * - BaseAgent.runAsync — individual agent invocations (TASK span)
 * - BaseTool/FunctionTool.runAsync — tool execution (TOOL span)
 *
 * LLM calls made through ADK are automatically captured by the existing
 * @google/genai instrumentation since ADK uses GenAI internally.
 */
export class GoogleADKPlugin extends BasePlugin {
  protected onEnable(): void {
    this.subscribeToRunnerRunAsync();
    this.subscribeToAgentRunAsync();
    this.subscribeToToolRunAsync();
  }

  protected onDisable(): void {
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.unsubscribers = [];
  }

  private subscribeToRunnerRunAsync(): void {
    const tracingChannel = googleADKChannels.runnerRunAsync.tracingChannel();
    const states = new WeakMap<object, RunnerState>();

    const handlers: IsoChannelHandlers<
      ChannelMessage<typeof googleADKChannels.runnerRunAsync>
    > = {
      start: (event) => {
        const params = (event.arguments[0] ?? {}) as GoogleADKRunAsyncParams;

        const span = startSpan({
          name: "Google ADK Runner",
          spanAttributes: {
            type: SpanTypeAttribute.TASK,
          },
        });
        const startTime = getCurrentUnixTimestamp();

        try {
          const metadata: Record<string, unknown> = {
            provider: "google-adk",
          };
          if (params.userId) {
            metadata["google_adk.user_id"] = params.userId;
          }
          if (params.sessionId) {
            metadata["google_adk.session_id"] = params.sessionId;
          }

          span.log({
            input: extractRunnerInput(params),
            metadata,
          });
        } catch {
          // Silently handle extraction errors
        }

        states.set(event, { span, startTime, events: [] });
      },

      end: (event) => {
        const state = states.get(event);
        if (!state) {
          return;
        }

        const result = event.result;
        if (isAsyncIterable(result)) {
          patchStreamIfNeeded<GoogleADKEvent>(result, {
            onChunk: (adkEvent: GoogleADKEvent) => {
              state.events.push(adkEvent);
            },
            onComplete: () => {
              finalizeRunnerSpan(state);
              states.delete(event);
            },
            onError: (error: Error) => {
              state.span.log({ error: error.message });
              state.span.end();
              states.delete(event);
            },
          });
          return;
        }

        // Non-streaming case (unlikely for runners but handle gracefully)
        try {
          state.span.log({ output: result });
        } finally {
          state.span.end();
          states.delete(event);
        }
      },

      error: (event) => {
        const state = states.get(event);
        if (!state || !event.error) {
          return;
        }
        state.span.log({ error: event.error.message });
        state.span.end();
        states.delete(event);
      },
    };

    tracingChannel.subscribe(handlers);
    this.unsubscribers.push(() => {
      tracingChannel.unsubscribe(handlers);
    });
  }

  private subscribeToAgentRunAsync(): void {
    const tracingChannel = googleADKChannels.agentRunAsync.tracingChannel();
    const states = new WeakMap<object, AgentState>();

    const handlers: IsoChannelHandlers<
      ChannelMessage<typeof googleADKChannels.agentRunAsync>
    > = {
      start: (event) => {
        const parentContext = event.arguments[0] as
          | Record<string, unknown>
          | undefined;

        // Extract agent info from the context if available
        const agentName = extractAgentName(parentContext);

        const span = startSpan({
          name: agentName ? `Agent: ${agentName}` : "Google ADK Agent",
          spanAttributes: {
            type: SpanTypeAttribute.TASK,
          },
        });
        const startTime = getCurrentUnixTimestamp();

        try {
          const metadata: Record<string, unknown> = {
            provider: "google-adk",
          };
          if (agentName) {
            metadata["google_adk.agent_name"] = agentName;
          }
          const modelName = extractModelName(parentContext);
          if (modelName) {
            metadata.model = modelName;
          }

          span.log({ metadata });
        } catch {
          // Silently handle extraction errors
        }

        states.set(event, { span, startTime, events: [] });
      },

      end: (event) => {
        const state = states.get(event);
        if (!state) {
          return;
        }

        const result = event.result;
        if (isAsyncIterable(result)) {
          patchStreamIfNeeded<GoogleADKEvent>(result, {
            onChunk: (adkEvent: GoogleADKEvent) => {
              state.events.push(adkEvent);
            },
            onComplete: () => {
              finalizeAgentSpan(state);
              states.delete(event);
            },
            onError: (error: Error) => {
              state.span.log({ error: error.message });
              state.span.end();
              states.delete(event);
            },
          });
          return;
        }

        try {
          state.span.log({ output: result });
        } finally {
          state.span.end();
          states.delete(event);
        }
      },

      error: (event) => {
        const state = states.get(event);
        if (!state || !event.error) {
          return;
        }
        state.span.log({ error: event.error.message });
        state.span.end();
        states.delete(event);
      },
    };

    tracingChannel.subscribe(handlers);
    this.unsubscribers.push(() => {
      tracingChannel.unsubscribe(handlers);
    });
  }

  private subscribeToToolRunAsync(): void {
    const tracingChannel = googleADKChannels.toolRunAsync.tracingChannel();
    const states = new WeakMap<object, ToolState>();

    const handlers: IsoChannelHandlers<
      ChannelMessage<typeof googleADKChannels.toolRunAsync>
    > = {
      start: (event) => {
        const req = (event.arguments[0] ?? {}) as GoogleADKToolRunRequest;

        const toolName = extractToolName(req);

        const span = startSpan({
          name: toolName ? `tool: ${toolName}` : "Google ADK Tool",
          spanAttributes: {
            type: SpanTypeAttribute.TOOL,
          },
          event: {
            input: req.args,
            metadata: {
              provider: "google-adk",
              ...(toolName && { "google_adk.tool_name": toolName }),
            },
          },
        });
        const startTime = getCurrentUnixTimestamp();

        states.set(event, { span, startTime });
      },

      asyncEnd: (event) => {
        const state = states.get(event);
        if (!state) {
          return;
        }

        try {
          const metrics: Record<string, number> = {};
          const end = getCurrentUnixTimestamp();
          metrics.start = state.startTime;
          metrics.end = end;
          metrics.duration = end - state.startTime;

          state.span.log({
            output: event.result,
            metrics: cleanMetrics(metrics),
          });
        } finally {
          state.span.end();
          states.delete(event);
        }
      },

      error: (event) => {
        const state = states.get(event);
        if (!state || !event.error) {
          return;
        }
        state.span.log({ error: event.error.message });
        state.span.end();
        states.delete(event);
      },
    };

    tracingChannel.subscribe(handlers);
    this.unsubscribers.push(() => {
      tracingChannel.unsubscribe(handlers);
    });
  }
}

// ---- Helper functions ----

function extractRunnerInput(
  params: GoogleADKRunAsyncParams,
): Record<string, unknown> | undefined {
  if (!params.newMessage) {
    return undefined;
  }

  const content = params.newMessage;
  if (content.parts && Array.isArray(content.parts)) {
    const textParts = content.parts
      .filter((p) => p.text !== undefined)
      .map((p) => p.text);
    if (textParts.length > 0) {
      return {
        messages: [
          { role: content.role ?? "user", content: textParts.join("") },
        ],
      };
    }
  }

  return { messages: [content] };
}

function extractAgentName(
  parentContext: Record<string, unknown> | undefined,
): string | undefined {
  if (!parentContext) {
    return undefined;
  }

  // InvocationContext has an `agent` property
  const agent = parentContext.agent as GoogleADKBaseAgent | undefined;
  return agent?.name;
}

function extractModelName(
  parentContext: Record<string, unknown> | undefined,
): string | undefined {
  if (!parentContext) {
    return undefined;
  }

  const agent = parentContext.agent as GoogleADKLlmAgent | undefined;
  if (!agent?.model) {
    return undefined;
  }

  if (typeof agent.model === "string") {
    return agent.model;
  }

  if (typeof agent.model === "object" && "model" in agent.model) {
    return agent.model.model;
  }

  return undefined;
}

function extractToolName(req: GoogleADKToolRunRequest): string | undefined {
  // The tool name is not in the request but on the tool instance.
  // We try to extract from toolContext if available.
  const toolContext = req.toolContext as Record<string, unknown> | undefined;
  if (toolContext) {
    const functionCallId = toolContext.functionCallId as string | undefined;
    if (functionCallId) {
      return functionCallId;
    }
  }
  return undefined;
}

function finalizeRunnerSpan(state: RunnerState): void {
  try {
    const lastEvent = getLastNonPartialEvent(state.events);
    const metrics: Record<string, number> = {};
    const end = getCurrentUnixTimestamp();
    metrics.start = state.startTime;
    metrics.end = end;
    metrics.duration = end - state.startTime;

    // Aggregate usage from all events
    const usage = aggregateUsageFromEvents(state.events);
    if (usage) {
      populateUsageMetrics(metrics, usage);
    }

    state.span.log({
      output: lastEvent ? extractEventOutput(lastEvent) : undefined,
      metrics: cleanMetrics(metrics),
    });
  } finally {
    state.span.end();
  }
}

function finalizeAgentSpan(state: AgentState): void {
  try {
    const lastEvent = getLastNonPartialEvent(state.events);
    const metrics: Record<string, number> = {};
    const end = getCurrentUnixTimestamp();
    metrics.start = state.startTime;
    metrics.end = end;
    metrics.duration = end - state.startTime;

    state.span.log({
      output: lastEvent ? extractEventOutput(lastEvent) : undefined,
      metrics: cleanMetrics(metrics),
    });
  } finally {
    state.span.end();
  }
}

function getLastNonPartialEvent(
  events: GoogleADKEvent[],
): GoogleADKEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (!events[i].partial) {
      return events[i];
    }
  }
  return events.length > 0 ? events[events.length - 1] : undefined;
}

function extractEventOutput(
  event: GoogleADKEvent,
): Record<string, unknown> | undefined {
  if (!event.content) {
    return undefined;
  }

  const output: Record<string, unknown> = {};

  if (event.content.role) {
    output.role = event.content.role;
  }

  if (event.content.parts && Array.isArray(event.content.parts)) {
    const textParts = event.content.parts
      .filter((p) => p.text !== undefined && !p.thought)
      .map((p) => p.text);
    const thoughtParts = event.content.parts
      .filter((p) => p.text !== undefined && p.thought)
      .map((p) => p.text);
    const functionCalls = event.content.parts
      .filter((p) => p.functionCall)
      .map((p) => p.functionCall);

    if (textParts.length > 0) {
      output.content = textParts.join("");
    }
    if (thoughtParts.length > 0) {
      output.thought = thoughtParts.join("");
    }
    if (functionCalls.length > 0) {
      output.functionCalls = functionCalls;
    }
  }

  if (event.author) {
    output.author = event.author;
  }

  return Object.keys(output).length > 0 ? output : undefined;
}

function aggregateUsageFromEvents(
  events: GoogleADKEvent[],
): GoogleADKUsageMetadata | undefined {
  let hasUsage = false;
  const aggregated: GoogleADKUsageMetadata = {};

  for (const event of events) {
    if (!event.usageMetadata) {
      continue;
    }
    hasUsage = true;
    const usage = event.usageMetadata;

    if (usage.promptTokenCount !== undefined) {
      aggregated.promptTokenCount =
        (aggregated.promptTokenCount ?? 0) + usage.promptTokenCount;
    }
    if (usage.candidatesTokenCount !== undefined) {
      aggregated.candidatesTokenCount =
        (aggregated.candidatesTokenCount ?? 0) + usage.candidatesTokenCount;
    }
    if (usage.totalTokenCount !== undefined) {
      aggregated.totalTokenCount =
        (aggregated.totalTokenCount ?? 0) + usage.totalTokenCount;
    }
    if (usage.cachedContentTokenCount !== undefined) {
      aggregated.cachedContentTokenCount =
        (aggregated.cachedContentTokenCount ?? 0) +
        usage.cachedContentTokenCount;
    }
    if (usage.thoughtsTokenCount !== undefined) {
      aggregated.thoughtsTokenCount =
        (aggregated.thoughtsTokenCount ?? 0) + usage.thoughtsTokenCount;
    }
  }

  return hasUsage ? aggregated : undefined;
}

function populateUsageMetrics(
  metrics: Record<string, number>,
  usage: GoogleADKUsageMetadata,
): void {
  if (usage.promptTokenCount !== undefined) {
    metrics.prompt_tokens = usage.promptTokenCount;
  }
  if (usage.candidatesTokenCount !== undefined) {
    metrics.completion_tokens = usage.candidatesTokenCount;
  }
  if (usage.totalTokenCount !== undefined) {
    metrics.tokens = usage.totalTokenCount;
  }
  if (usage.cachedContentTokenCount !== undefined) {
    metrics.prompt_cached_tokens = usage.cachedContentTokenCount;
  }
  if (usage.thoughtsTokenCount !== undefined) {
    metrics.completion_reasoning_tokens = usage.thoughtsTokenCount;
  }
}

function cleanMetrics(metrics: Record<string, number>): Record<string, number> {
  const cleaned: Record<string, number> = {};
  for (const [key, value] of Object.entries(metrics)) {
    if (value !== null && value !== undefined) {
      cleaned[key] = value;
    }
  }
  return cleaned;
}
