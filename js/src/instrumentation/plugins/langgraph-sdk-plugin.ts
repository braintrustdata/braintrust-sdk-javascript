import { isObject, SpanTypeAttribute } from "../../../util";
import { debugLogger } from "../../debug-logger";
import { startSpan, withCurrent, type Span } from "../../logger";
import {
  INSTRUMENTATION_NAMES,
  withSpanInstrumentationName,
} from "../../span-origin";
import { getCurrentUnixTimestamp } from "../../util";
import type {
  LangGraphRunArgs,
  LangGraphStreamEvent,
} from "../../vendor-sdk-types/langgraph-sdk";
import {
  isAutoInstrumentationSuppressed,
  runWithAutoInstrumentationSuppressed,
} from "../auto-instrumentation-suppression";
import { BasePlugin } from "../core";
import { unsubscribeAll } from "../core/channel-tracing";
import { patchStreamIfNeeded } from "../core/stream-patcher";
import { langGraphSDKChannels } from "./langgraph-sdk-channels";

export class LangGraphSDKPlugin extends BasePlugin {
  protected onEnable(): void {
    this.unsubscribers.push(
      langGraphSDKChannels.wait.intercept((target, self, args) =>
        instrumentRun("wait", args, () => Reflect.apply(target, self, args)),
      ),
      langGraphSDKChannels.stream.intercept((target, self, args) =>
        instrumentRun("stream", args, () => Reflect.apply(target, self, args)),
      ),
    );
  }

  protected onDisable(): void {
    this.unsubscribers = unsubscribeAll(this.unsubscribers);
  }
}

// Normalize only message fields; arbitrary graph state is application data.
function normalizeMessage(value: unknown): unknown {
  if (!isObject(value)) return value;
  const role =
    value.role ??
    (value.type === "human"
      ? "user"
      : value.type === "ai" || value.type === "AIMessageChunk"
        ? "assistant"
        : value.type === "system" ||
            value.type === "tool" ||
            value.type === "function"
          ? value.type
          : undefined);
  if (typeof role !== "string") return value;
  const message: Record<string, unknown> = {
    role,
    content: value.content ?? "",
  };
  for (const key of ["name", "tool_call_id", "refusal"] as const) {
    if (value[key] !== undefined) message[key] = value[key];
  }
  const additional = isObject(value.additional_kwargs)
    ? value.additional_kwargs
    : {};
  const toolCalls =
    Array.isArray(value.tool_calls) && value.tool_calls.length
      ? value.tool_calls
      : additional.tool_calls;
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    message.tool_calls = toolCalls.map((call) => {
      if (!isObject(call)) return call;
      if (isObject(call.function)) return call;
      return {
        id: call.id,
        type: "function",
        function: {
          name: call.name,
          arguments:
            typeof call.args === "string"
              ? call.args
              : JSON.stringify(call.args ?? {}),
        },
      };
    });
  }
  // Invalid calls and refusals are meaningful output, unlike empty SDK fields.
  if (
    Array.isArray(value.invalid_tool_calls) &&
    value.invalid_tool_calls.length > 0
  )
    message.invalid_tool_calls = value.invalid_tool_calls;
  if (message.refusal === undefined && additional.refusal !== undefined)
    message.refusal = additional.refusal;
  return message;
}

function normalizeRunError(value: unknown): unknown {
  let name: string;
  let message: string;
  if (value instanceof Error) {
    name = value.name;
    message = value.message;
  } else if (
    isObject(value) &&
    typeof value.error === "string" &&
    typeof value.message === "string"
  ) {
    name = value.error;
    message = value.message;
  } else {
    return value;
  }
  // The server may serialize a graph exception into another exception's message.
  for (let depth = 0; depth < 3; depth++) {
    try {
      const nested: unknown = JSON.parse(
        message.startsWith(`${name}: `)
          ? message.slice(name.length + 2)
          : message,
      );
      if (
        !isObject(nested) ||
        typeof nested.error !== "string" ||
        typeof nested.message !== "string"
      )
        break;
      name = nested.error;
      message = nested.message;
    } catch {
      break;
    }
  }
  if (
    value instanceof Error &&
    name === value.name &&
    message === value.message
  )
    return value;
  return Object.assign(new Error(message), { name });
}

function normalizeState(value: unknown): unknown {
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, field]) => {
      if (key === "messages" && Array.isArray(field))
        return [key, field.map(normalizeMessage)];
      if (key === "__error__") {
        const error = normalizeRunError(field);
        if (error instanceof Error)
          return [key, { error: error.name, message: error.message }];
      }
      return [key, field];
    }),
  );
}

function normalizeRunOutput(value: unknown, input: unknown): unknown {
  if (!isObject(value)) return value;
  if (Array.isArray(value.messages)) {
    // A paused/failed state can contain only a previous turn's answer.
    // Any generated streaming content is retained separately by the caller.
    if (value.__interrupt__ !== undefined || value.__error__ !== undefined)
      return undefined;
    const inputMessages =
      isObject(input) && Array.isArray(input.messages) ? input.messages : [];
    let inputPrefixLength = 0;
    while (inputPrefixLength < inputMessages.length) {
      const previous = inputMessages[inputPrefixLength];
      const message = value.messages[inputPrefixLength];
      if (
        (isObject(previous) &&
          isObject(message) &&
          previous.id !== undefined &&
          message.id !== undefined &&
          previous.id !== message.id) ||
        JSON.stringify(normalizeMessage(previous)) !==
          JSON.stringify(normalizeMessage(message))
      )
        break;
      inputPrefixLength++;
    }
    // Agent spans show the final generated response, not the conversation or
    // intermediate tool results carried in the graph's state.
    for (
      let index = value.messages.length - 1;
      index >= inputPrefixLength;
      index--
    ) {
      const message = value.messages[index];
      const normalized = normalizeMessage(message);
      if (!isObject(normalized)) continue;
      if (normalized.role === "user") return undefined;
      if (normalized.role !== "assistant") continue;
      if (
        inputMessages.some((previous) => {
          if (!isObject(previous) || !isObject(message)) return false;
          return (
            previous.id !== undefined &&
            previous.id === message.id &&
            JSON.stringify(normalizeMessage(previous)) ===
              JSON.stringify(normalized)
          );
        })
      )
        continue;
      return normalized;
    }
    return undefined;
  }
  // Graphs with non-message output still have a useful structured result.
  // Interrupts and errors are run status, rather than generated content.
  const result = Object.fromEntries(
    Object.entries(value).filter(
      ([key]) => key !== "__interrupt__" && key !== "__error__",
    ),
  );
  return !Object.keys(result).length &&
    (value.__interrupt__ !== undefined || value.__error__ !== undefined)
    ? undefined
    : result;
}

function instrumentRun<T>(
  operation: "wait" | "stream",
  [threadId, assistantId, options]: LangGraphRunArgs,
  invoke: () => T,
): T {
  if (isAutoInstrumentationSuppressed()) return invoke();
  const start = getCurrentUnixTimestamp();
  let span: Span;
  try {
    // The remote server owns the agent loop. These client task spans do not
    // invent LLM/tool children or token counts that the server has not exposed.
    const metadata: Record<string, unknown> = {
      "langgraph.thread_id": threadId,
      "langgraph.assistant_id": assistantId,
    };
    for (const key of [
      "streamMode",
      "streamSubgraphs",
      "interruptBefore",
      "interruptAfter",
      "multitaskStrategy",
      "durability",
    ] as const) {
      if (options?.[key] !== undefined) metadata[key] = options[key];
    }
    span = startSpan(
      withSpanInstrumentationName(
        {
          name: `langgraph.runs.${operation}`,
          spanAttributes: { type: SpanTypeAttribute.TASK },
          event: {
            input:
              options?.command === undefined
                ? normalizeState(options?.input)
                : {
                    input: normalizeState(options.input),
                    command: options.command,
                  },
            metadata,
          },
        },
        INSTRUMENTATION_NAMES.LANGGRAPH_SDK,
      ),
    );
  } catch (error) {
    debugLogger.error("Error starting LangGraph SDK span:", error);
    return invoke();
  }

  let ended = false;
  let output: unknown;
  let streamError: unknown;
  let firstToken: number | undefined;
  const updates: unknown[] = [];
  const usageByMessage = new Map<string, Record<string, number>>();
  const captureUsage = (id: string, usage: unknown) => {
    if (!isObject(usage)) return;
    const metrics: Record<string, number> = {};
    for (const [source, destination] of [
      ["input_tokens", "prompt_tokens"],
      ["output_tokens", "completion_tokens"],
      ["total_tokens", "tokens"],
    ] as const) {
      const value = usage[source];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0)
        metrics[destination] = value;
    }
    if (
      metrics.tokens === undefined &&
      metrics.prompt_tokens !== undefined &&
      metrics.completion_tokens !== undefined
    )
      metrics.tokens = metrics.prompt_tokens + metrics.completion_tokens;
    usageByMessage.set(id, { ...usageByMessage.get(id), ...metrics });
  };
  const messages = new Map<string, Record<string, unknown>>();
  const messageSnapshots = new Map<string, Record<string, unknown>>();
  const finish = (error?: unknown) => {
    if (ended) return;
    ended = true;
    try {
      const metrics: Record<string, number> = {};
      for (const usage of usageByMessage.values()) {
        for (const [key, value] of Object.entries(usage))
          metrics[key] = (metrics[key] ?? 0) + value;
      }
      if (firstToken !== undefined)
        metrics.time_to_first_token = firstToken - start;
      const finalMessages = [
        ...new Map([...messages, ...messageSnapshots]).values(),
      ];
      let loggedOutput = normalizeRunOutput(output, options?.input);
      if (loggedOutput === undefined && finalMessages.length)
        loggedOutput = normalizeRunOutput(
          { messages: finalMessages },
          undefined,
        );
      if (output === undefined && !finalMessages.length && updates.length) {
        const results = updates
          .map((update) => normalizeRunOutput(update, options?.input))
          .filter((update) => update !== undefined);
        if (results.length) loggedOutput = { updates: results };
      }
      const interrupted = [output, ...updates].find(
        (state) => isObject(state) && state.__interrupt__ !== undefined,
      );
      span.log({
        ...(loggedOutput !== undefined ? { output: loggedOutput } : {}),
        ...(isObject(interrupted)
          ? { metadata: { "langgraph.interrupts": interrupted.__interrupt__ } }
          : {}),
        ...(error !== undefined || streamError !== undefined
          ? { error: normalizeRunError(error ?? streamError) }
          : {}),
        metrics,
      });
    } catch (error) {
      debugLogger.error("Error logging LangGraph SDK span:", error);
    }
    try {
      span.end();
    } catch (error) {
      debugLogger.error("Error ending LangGraph SDK span:", error);
    }
  };
  const observeMessages = (value: unknown, streaming: boolean) => {
    if (!isObject(value) || !Array.isArray(value.messages)) return;
    const inputMessages =
      isObject(options?.input) && Array.isArray(options.input.messages)
        ? options.input.messages
        : [];
    for (const message of value.messages) {
      if (
        !isObject(message) ||
        (message.type !== "ai" && message.role !== "assistant")
      )
        continue;
      // State snapshots may include messages from earlier turns.
      if (
        message.id !== undefined &&
        inputMessages.some(
          (input) => isObject(input) && input.id === message.id,
        )
      )
        continue;
      captureUsage(
        typeof message.id === "string" ? message.id : "message",
        message.usage_metadata,
      );
      if (
        streaming &&
        (typeof message.content === "string"
          ? message.content.length > 0
          : Array.isArray(message.content) &&
            message.content.some(
              (part) =>
                isObject(part) &&
                typeof part.text === "string" &&
                part.text.length > 0,
            ))
      )
        firstToken ??= getCurrentUnixTimestamp();
    }
  };
  const onChunk = ({ event, data }: LangGraphStreamEvent) => {
    if (ended) return;
    if (event === "metadata" && isObject(data)) {
      if (typeof data.run_id === "string")
        span.log({ metadata: { "langgraph.run_id": data.run_id } });
    } else if (event === "error") {
      streamError = normalizeRunError(data);
    } else if (event === "values") {
      output = data;
      observeMessages(data, true);
    } else if (event === "updates") {
      if (isObject(data)) {
        const stateUpdates: Array<[string, unknown]> = [];
        for (const [node, update] of Object.entries(data)) {
          observeMessages(update, true);
          if (isObject(update) && Array.isArray(update.messages)) {
            for (const message of update.messages) {
              if (isObject(message))
                messageSnapshots.set(
                  typeof message.id === "string"
                    ? message.id
                    : `update-${messageSnapshots.size}`,
                  message,
                );
            }
            const state = Object.fromEntries(
              Object.entries(update).filter(([key]) => key !== "messages"),
            );
            if (Object.keys(state).length) stateUpdates.push([node, state]);
          } else {
            stateUpdates.push([node, update]);
          }
        }
        if (stateUpdates.length) updates.push(Object.fromEntries(stateUpdates));
      } else {
        updates.push(data);
      }
    } else if (
      (event === "messages" ||
        event === "messages/partial" ||
        event === "messages/complete") &&
      Array.isArray(data)
    ) {
      const parts = event === "messages" ? [data[0]] : data;
      for (const part of parts) {
        if (!isObject(part)) continue;
        const id = typeof part.id === "string" ? part.id : "message";
        captureUsage(id, part.usage_metadata);
        const previous = messages.get(id);
        // `messages` carries deltas; the other modes carry message snapshots.
        messages.set(
          id,
          event === "messages" &&
            previous &&
            typeof part.content === "string" &&
            typeof previous.content === "string"
            ? { ...part, content: previous.content + part.content }
            : part,
        );
        if (typeof part.content === "string" && part.content.length > 0)
          firstToken ??= getCurrentUnixTimestamp();
      }
    }
  };

  let result: T;
  try {
    result = withCurrent(span, () =>
      runWithAutoInstrumentationSuppressed(invoke),
    );
  } catch (error) {
    finish(error);
    throw error;
  }
  if (operation === "stream") {
    try {
      patchStreamIfNeeded<LangGraphStreamEvent>(result, {
        shouldCollect: (chunk) => {
          try {
            onChunk(chunk);
          } catch (error) {
            debugLogger.error(
              "Error processing LangGraph stream event:",
              error,
            );
          }
          return false;
        },
        aroundNext: (next) =>
          withCurrent(span, () => runWithAutoInstrumentationSuppressed(next)),
        onComplete: () => finish(),
        onCancel: () => finish(),
        onError: (error) => finish(error),
      });
    } catch (error) {
      debugLogger.error("Error observing LangGraph stream:", error);
      finish();
    }
  } else {
    // Observe the original promise, retaining its identity and helper methods.
    void Promise.resolve(result).then(
      (value) => {
        try {
          output = value;
          observeMessages(value, false);
          if (isObject(value) && isObject(value.__error__))
            streamError = normalizeRunError(value.__error__);
          finish();
        } catch (error) {
          finish(error);
        }
      },
      (error) => finish(error),
    );
  }
  return result;
}
