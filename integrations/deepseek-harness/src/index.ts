import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
// Load the Harness packages' compile-time Cordis event augmentations.
import type {} from "@deepseek-ai/dsh-llm";
import type {} from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import {
  Attachment,
  initLogger,
  NOOP_SPAN,
  withCurrent,
  type Span,
  type StartSpanArgs,
} from "braintrust";
import type {
  HarnessAttachmentStore,
  HarnessContentBlock,
  HarnessGenerateOptions,
  HarnessImageAttachmentRef,
  HarnessMessage,
  HarnessSession,
  HarnessSessionEvent,
  HarnessStreamChunk,
  HarnessToolExecution,
  HarnessToolResult,
  HarnessUsage,
} from "./vendor";

const DEFAULT_PROJECT_NAME = "DeepSeek Harness";
const INSTRUMENTATION_NAME = "deepseek-harness";
const INSTRUMENTATION_SYMBOL = Symbol.for("braintrust.spanInstrumentationName");

/** Stable Cordis plugin name. */
export const name = "braintrust";

/** Harness services whose event seams this plugin instruments. */
export const inject = ["sessions", "llm", "tools"];

export interface Config {
  /** Braintrust API key. Falls back to BRAINTRUST_API_KEY when omitted. */
  apiKey?: string;
  /** Braintrust project receiving Harness traces. */
  projectName?: string;
  /** Optional Braintrust organization name. */
  orgName?: string;
  /** Optional Braintrust deployment URL. */
  appUrl?: string;
}

export const Config: z<Config> = z.object({
  apiKey: z.string().role("secret"),
  projectName: z.string().default(DEFAULT_PROJECT_NAME),
  orgName: z.string(),
  appUrl: z.string(),
});

type TokenMetrics = Record<string, number> & {
  tokens: number;
  prompt_tokens: number;
  completion_tokens: number;
  completion_reasoning_tokens?: number;
  prompt_cached_tokens?: number;
  prompt_cache_creation_tokens?: number;
};

interface TurnState {
  readonly sessionId: string;
  readonly turn: number;
  readonly span: Span;
  readonly input: Promise<Record<string, unknown>>[];
  metrics: TokenMetrics;
  output?: string;
}

interface ToolState {
  readonly span: Span;
  readonly turn?: TurnState;
}

interface AssistantAccumulator {
  readonly blocks: Map<number, HarnessContentBlock>;
  readonly text: Map<number, string>;
  readonly reasoning: Map<number, string>;
  readonly toolCalls: Map<
    number,
    { id: string; name: string; arguments: string }
  >;
  usage?: HarnessUsage;
  finishReason?: string;
  failure?: string;
}

function spanArgs(args: StartSpanArgs): StartSpanArgs {
  return Object.assign(args, {
    [INSTRUMENTATION_SYMBOL]: INSTRUMENTATION_NAME,
  });
}

function contentText(blocks: readonly HarnessContentBlock[]): string {
  return blocks
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

async function normalizeBlocks(
  blocks: readonly HarnessContentBlock[],
  resolveImage: (
    ref: HarnessImageAttachmentRef,
  ) => Promise<Attachment | undefined>,
): Promise<unknown> {
  if (blocks.length === 0) return "";
  if (blocks.every((block) => block.type === "text")) {
    return contentText(blocks);
  }
  return Promise.all(
    blocks.map(async (block) => {
      switch (block.type) {
        case "text":
          return { type: "text", text: block.text ?? "" };
        case "reasoning":
          return { type: "reasoning", text: block.text ?? "" };
        case "tool-call":
          return {
            type: "tool_call",
            id: block.id,
            name: block.name,
            arguments: block.arguments,
          };
        case "tool-result":
          return {
            type: "tool_result",
            tool_call_id: block.toolCallId,
            content: await normalizeBlocks(block.content ?? [], resolveImage),
            ...(block.isError ? { is_error: true } : {}),
          };
        case "image": {
          const attachment = block.attachment
            ? await resolveImage(block.attachment)
            : undefined;
          return attachment
            ? { type: "image_url", image_url: { url: attachment } }
            : { type: "image", attachment: block.attachment };
        }
        default:
          return { type: block.type };
      }
    }),
  );
}

async function normalizeMessage(
  message: HarnessMessage,
  resolveImage: (
    ref: HarnessImageAttachmentRef,
  ) => Promise<Attachment | undefined>,
): Promise<Record<string, unknown>> {
  const toolResult = message.content.find(
    (block) => block.type === "tool-result",
  );
  if (toolResult) {
    return {
      role: "tool",
      tool_call_id: toolResult.toolCallId ?? message.source?.callId,
      content: await normalizeBlocks(toolResult.content ?? [], resolveImage),
    };
  }

  const normalized: Record<string, unknown> = { role: message.role };
  if (message.role === "assistant") {
    normalized.content = contentText(message.content);
    const reasoning = message.content
      .filter(
        (block) => block.type === "reasoning" && typeof block.text === "string",
      )
      .map((block) => block.text)
      .join("");
    if (reasoning) normalized.reasoning = [{ content: reasoning }];
    const calls = message.content
      .filter((block) => block.type === "tool-call")
      .map((block) => ({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: block.arguments },
      }));
    if (calls.length > 0) normalized.tool_calls = calls;
  } else {
    normalized.content = await normalizeBlocks(message.content, resolveImage);
  }
  return normalized;
}

async function normalizeInput(
  options: HarnessGenerateOptions,
  resolveImage: (
    ref: HarnessImageAttachmentRef,
  ) => Promise<Attachment | undefined>,
): Promise<unknown[]> {
  return [
    ...(options.system ? [{ role: "system", content: options.system }] : []),
    ...(await Promise.all(
      options.messages.map((message) =>
        normalizeMessage(message, resolveImage),
      ),
    )),
  ];
}

function usageMetrics(usage: HarnessUsage): TokenMetrics {
  const promptTokens =
    usage.inputTokens +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheWriteTokens ?? 0);
  const metrics: TokenMetrics = {
    prompt_tokens: promptTokens,
    completion_tokens: usage.outputTokens,
    tokens: promptTokens + usage.outputTokens,
  };
  if (usage.reasoningTokens !== undefined) {
    metrics.completion_reasoning_tokens = usage.reasoningTokens;
  }
  if (usage.cacheReadTokens !== undefined) {
    metrics.prompt_cached_tokens = usage.cacheReadTokens;
  }
  if (usage.cacheWriteTokens !== undefined) {
    metrics.prompt_cache_creation_tokens = usage.cacheWriteTokens;
  }
  return metrics;
}

function addMetrics(target: TokenMetrics, incoming: TokenMetrics): void {
  target.prompt_tokens += incoming.prompt_tokens;
  target.completion_tokens += incoming.completion_tokens;
  target.tokens += incoming.tokens;
  for (const key of [
    "completion_reasoning_tokens",
    "prompt_cached_tokens",
    "prompt_cache_creation_tokens",
  ] as const) {
    if (incoming[key] !== undefined) {
      target[key] = (target[key] ?? 0) + incoming[key];
    }
  }
}

function emptyMetrics(): TokenMetrics {
  return { tokens: 0, prompt_tokens: 0, completion_tokens: 0 };
}

function consumeChunk(
  accumulator: AssistantAccumulator,
  chunk: HarnessStreamChunk,
): void {
  switch (chunk.type) {
    case "text-delta":
      accumulator.text.set(
        chunk.index,
        `${accumulator.text.get(chunk.index) ?? ""}${chunk.text}`,
      );
      break;
    case "reasoning-delta":
      accumulator.reasoning.set(
        chunk.index,
        `${accumulator.reasoning.get(chunk.index) ?? ""}${chunk.text}`,
      );
      break;
    case "tool-call-delta": {
      const current = accumulator.toolCalls.get(chunk.index);
      accumulator.toolCalls.set(chunk.index, {
        id: chunk.id,
        name: chunk.name ?? current?.name ?? "",
        arguments: `${current?.arguments ?? ""}${chunk.argumentsDelta}`,
      });
      break;
    }
    case "block-end":
      accumulator.blocks.set(chunk.index, chunk.block);
      break;
    case "usage":
      accumulator.usage = chunk.usage;
      break;
    case "finish":
      accumulator.finishReason = chunk.reason.kind;
      accumulator.failure = chunk.reason.failure?.message;
      break;
  }
}

function normalizeOutput(accumulator: AssistantAccumulator): unknown[] {
  const completed = [...accumulator.blocks.entries()].sort(
    ([left], [right]) => left - right,
  );
  const text =
    completed
      .filter(([, block]) => block.type === "text")
      .map(([, block]) => block.text ?? "")
      .join("") ||
    [...accumulator.text.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, value]) => value)
      .join("");
  const reasoning =
    completed
      .filter(([, block]) => block.type === "reasoning")
      .map(([, block]) => block.text ?? "")
      .join("") ||
    [...accumulator.reasoning.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, value]) => value)
      .join("");
  const completedCalls = completed
    .filter(([, block]) => block.type === "tool-call")
    .map(([, block]) => ({
      id: block.id,
      name: block.name ?? "",
      arguments: block.arguments ?? "",
    }));
  const calls =
    completedCalls.length > 0
      ? completedCalls
      : [...accumulator.toolCalls.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, call]) => call);
  const message: Record<string, unknown> = {
    role: "assistant",
    content: text,
  };
  if (reasoning) message.reasoning = [{ content: reasoning }];
  if (calls.length > 0) {
    message.tool_calls = calls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    }));
  }
  const reason = accumulator.finishReason;
  return [
    {
      index: 0,
      message,
      finish_reason:
        reason === "tool-calls"
          ? "tool_calls"
          : reason === "max-tokens"
            ? "length"
            : reason === "error" || reason === "aborted"
              ? reason
              : "stop",
    },
  ];
}

function eventMessage(
  data: Record<string, unknown>,
): HarnessMessage | undefined {
  const candidate = "message" in data ? data.message : data;
  if (!candidate || typeof candidate !== "object") return undefined;
  const message = candidate as Partial<HarnessMessage>;
  return Array.isArray(message.content) && typeof message.role === "string"
    ? (message as HarnessMessage)
    : undefined;
}

/** Install Braintrust tracing into a DeepSeek Harness Cordis context. */
export function apply(ctx: Context, config: Config = {}): void {
  const logger = initLogger({
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    projectName: config.projectName ?? DEFAULT_PROJECT_NAME,
    ...(config.orgName ? { orgName: config.orgName } : {}),
    ...(config.appUrl ? { appUrl: config.appUrl } : {}),
    setCurrent: false,
  });
  const turns = new Map<string, Map<number, TurnState>>();
  const activeTurns = new Map<string, TurnState>();
  const childParents = new Map<string, Span>();
  const toolSpans = new Map<symbol, Span>();
  const toolContext = new AsyncLocalStorage<ToolState>();
  const attachmentCache = new Map<string, Promise<Attachment>>();
  const pendingLogs = new Set<Promise<void>>();

  const warn = (message: string, error: unknown): void => {
    try {
      ctx.logger.warn(`${message}: ${String(error)}`);
    } catch {
      // Diagnostics must never affect Harness execution.
    }
  };

  const resolveImage = async (
    ref: HarnessImageAttachmentRef,
  ): Promise<Attachment | undefined> => {
    const attachmentStore = (
      ctx as Context & { attachments?: HarnessAttachmentStore }
    ).attachments;
    if (!attachmentStore) {
      warn(
        "Braintrust could not convert a Harness image attachment",
        new Error("Harness attachment service is unavailable"),
      );
      return undefined;
    }
    const key = String(ref.attachmentId);
    let pending = attachmentCache.get(key);
    if (!pending) {
      pending = attachmentStore.readImage(ref).then((stored) => {
        const mediaType = stored.ref.mediaType;
        return new Attachment({
          data: new Uint8Array(stored.data).buffer,
          filename:
            stored.ref.name ??
            `attachment.${mediaType === "image/jpeg" ? "jpg" : mediaType.slice("image/".length)}`,
          contentType: mediaType,
        });
      });
      attachmentCache.set(key, pending);
    }
    try {
      return await pending;
    } catch (error) {
      attachmentCache.delete(key);
      warn("Braintrust could not convert a Harness image attachment", error);
      return undefined;
    }
  };

  const trackPendingLog = (pending: Promise<void>): void => {
    pendingLogs.add(pending);
    void pending.finally(() => pendingLogs.delete(pending));
  };

  const flushPendingLogs = async (): Promise<void> => {
    while (pendingLogs.size > 0) {
      await Promise.allSettled([...pendingLogs]);
    }
  };

  const startChild = (parent: Span | undefined, args: StartSpanArgs): Span => {
    if (parent) return parent.startSpan(spanArgs(args));
    const spanId = randomUUID();
    return withCurrent(NOOP_SPAN, () =>
      logger.startSpan(
        spanArgs({
          ...args,
          spanId,
          parentSpanIds: { parentSpanIds: [], rootSpanId: randomUUID() },
        }),
      ),
    );
  };

  ctx.on("session/created", (rawSession) => {
    try {
      const session = rawSession as unknown as HarnessSession;
      const currentTool = toolContext.getStore();
      if (session.header.parentSession && currentTool) {
        childParents.set(session.id, currentTool.span);
      }
    } catch (error) {
      warn("Braintrust could not correlate a Harness child session", error);
    }
  });

  ctx.on("session/disposed", (rawSession) => {
    const session = rawSession as unknown as HarnessSession;
    childParents.delete(String(session.id));
  });

  ctx.on("session/event", (rawSession, rawEvent) => {
    try {
      const session = rawSession as unknown as HarnessSession;
      const event = rawEvent as unknown as HarnessSessionEvent;
      const sessionId = String(session.id);
      if (event.type === "turn/start") {
        const turn = Number(event.data.turn);
        if (!Number.isSafeInteger(turn)) return;
        const parent = session.header.parentSession
          ? childParents.get(sessionId)
          : undefined;
        const span = startChild(parent, {
          name: "deepseek_harness.turn",
          type: "task",
          event: {
            metadata: {
              "deepseek_harness.session_id": sessionId,
              "deepseek_harness.turn": turn,
              ...(session.header.parentSession
                ? {
                    "deepseek_harness.parent_session_id":
                      session.header.parentSession,
                  }
                : {}),
            },
          },
        });
        const state: TurnState = {
          sessionId,
          turn,
          span,
          input: [],
          metrics: emptyMetrics(),
        };
        const sessionTurns = turns.get(sessionId) ?? new Map();
        sessionTurns.set(turn, state);
        turns.set(sessionId, sessionTurns);
        activeTurns.set(sessionId, state);
        return;
      }

      const eventTurn = Number(event.data.turn);
      const state = Number.isSafeInteger(eventTurn)
        ? turns.get(sessionId)?.get(eventTurn)
        : activeTurns.get(sessionId);
      if (!state) return;

      if (event.type === "user/message") {
        const message = eventMessage(event.data);
        if (message) {
          state.input.push(normalizeMessage(message, resolveImage));
          const pending = Promise.all(state.input)
            .then((input) => state.span.log({ input }))
            .catch((error) =>
              warn(
                "Braintrust could not normalize a Harness turn input",
                error,
              ),
            );
          trackPendingLog(pending);
        }
      } else if (event.type === "assistant/message") {
        const message = eventMessage(event.data);
        if (message) state.output = contentText(message.content);
      } else if (event.type === "turn/end") {
        const reason = event.data.reason as
          | { kind?: string; error?: { message?: string } }
          | undefined;
        state.span.log({
          ...(state.output !== undefined ? { output: state.output } : {}),
          metrics: state.metrics,
          ...(reason?.kind === "error"
            ? {
                error: new Error(
                  reason.error?.message ?? "Harness turn failed",
                ),
              }
            : {}),
          metadata: {
            "deepseek_harness.stop_reason": reason?.kind ?? "unknown",
          },
        });
        state.span.end();
        const sessionTurns = turns.get(sessionId);
        sessionTurns?.delete(state.turn);
        if (sessionTurns?.size === 0) turns.delete(sessionId);
        if (activeTurns.get(sessionId) === state) activeTurns.delete(sessionId);
      }
    } catch (error) {
      warn("Braintrust could not process a Harness session event", error);
    }
  });

  ctx.on("session/flush", async () => {
    await flushPendingLogs();
    attachmentCache.clear();
  });

  ctx.on("llm/stream", (rawOptions, next) => {
    const options = rawOptions as unknown as HarnessGenerateOptions;
    let span: Span | undefined;
    let turn: TurnState | undefined;
    try {
      turn = options.sessionId
        ? activeTurns.get(String(options.sessionId))
        : undefined;
      const metadata: Record<string, unknown> = {
        model: options.model,
        provider: options.provider,
        ...(options.temperature !== undefined
          ? { temperature: options.temperature }
          : {}),
        ...(options.maxTokens !== undefined
          ? { max_tokens: options.maxTokens }
          : {}),
        ...(options.stop !== undefined ? { stop: options.stop } : {}),
        ...(options.tools && options.tools.length > 0
          ? {
              tools: options.tools.map((tool) => ({
                type: "function",
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters,
                },
              })),
            }
          : {}),
        ...(options.sessionId
          ? { "deepseek_harness.session_id": String(options.sessionId) }
          : {}),
        ...(options.purpose
          ? { "deepseek_harness.purpose": options.purpose }
          : {}),
      };
      span = startChild(turn?.span, {
        name: "deepseek_harness.step",
        type: "llm",
        event: { metadata },
      });
      const modelSpan = span;
      const pending = normalizeInput(options, resolveImage)
        .then((input) => modelSpan.log({ input }))
        .catch((error) =>
          warn("Braintrust could not normalize a Harness model input", error),
        );
      trackPendingLog(pending);
    } catch (error) {
      warn("Braintrust could not start a Harness model span", error);
    }

    let iterable: AsyncIterable<HarnessStreamChunk>;
    try {
      iterable = next() as AsyncIterable<HarnessStreamChunk>;
    } catch (error) {
      try {
        span?.log({ error });
        span?.end();
      } catch (loggingError) {
        warn(
          "Braintrust could not close a rejected Harness model span",
          loggingError,
        );
      }
      throw error;
    }
    if (!span) return iterable as never;
    const modelSpan = span;
    const startedAt = Date.now();
    const accumulator: AssistantAccumulator = {
      blocks: new Map(),
      text: new Map(),
      reasoning: new Map(),
      toolCalls: new Map(),
    };

    return (async function* () {
      let firstChunk = true;
      try {
        for await (const chunk of iterable) {
          if (firstChunk) {
            firstChunk = false;
            modelSpan.log({
              metrics: { time_to_first_token: (Date.now() - startedAt) / 1000 },
            });
          }
          try {
            consumeChunk(accumulator, chunk);
          } catch (error) {
            warn(
              "Braintrust could not accumulate a Harness model chunk",
              error,
            );
          }
          yield chunk;
        }
        const metrics = accumulator.usage
          ? usageMetrics(accumulator.usage)
          : undefined;
        modelSpan.log({
          output: normalizeOutput(accumulator),
          ...(metrics ? { metrics } : {}),
          ...(accumulator.failure
            ? { error: new Error(accumulator.failure) }
            : {}),
        });
        if (metrics && turn) addMetrics(turn.metrics, metrics);
      } catch (error) {
        try {
          modelSpan.log({ error });
        } catch (loggingError) {
          warn("Braintrust could not log a Harness model error", loggingError);
        }
        throw error;
      } finally {
        try {
          modelSpan.end();
        } catch (error) {
          warn("Braintrust could not end a Harness model span", error);
        }
      }
    })() as never;
  });

  ctx.on("tools/execute", async (rawExec, next) => {
    const exec = rawExec as unknown as HarnessToolExecution;
    let span: Span | undefined;
    let turn: TurnState | undefined;
    try {
      const sessionId = exec.agent?.session.id;
      turn = sessionId ? activeTurns.get(String(sessionId)) : undefined;
      const parent = exec.parent ? toolSpans.get(exec.parent) : turn?.span;
      span = startChild(parent, {
        name: exec.name,
        type: "tool",
        event: {
          input: exec.arguments,
          metadata: {
            ...(sessionId
              ? { "deepseek_harness.session_id": String(sessionId) }
              : {}),
            "deepseek_harness.call_id": String(exec.callId),
          },
        },
      });
      toolSpans.set(exec.token, span);
    } catch (error) {
      warn("Braintrust could not start a Harness tool span", error);
    }

    try {
      const result = await (span
        ? toolContext.run({ span, turn }, () => next())
        : next());
      if (span) {
        const normalized = result as unknown as HarnessToolResult;
        const error = normalized.isError
          ? new Error(
              normalized.error?.message ||
                contentText(normalized.content ?? []) ||
                "Harness tool failed",
            )
          : undefined;
        if (normalized.value !== undefined) {
          span.log({
            output: normalized.value,
            ...(error ? { error } : {}),
          });
        } else {
          const toolSpan = span;
          const pending = normalizeBlocks(
            normalized.content ?? [],
            resolveImage,
          )
            .then((output) =>
              toolSpan.log({ output, ...(error ? { error } : {}) }),
            )
            .catch((loggingError) =>
              warn(
                "Braintrust could not normalize a Harness tool output",
                loggingError,
              ),
            );
          trackPendingLog(pending);
        }
      }
      return result;
    } catch (error) {
      try {
        span?.log({ error });
      } catch (loggingError) {
        warn("Braintrust could not log a Harness tool error", loggingError);
      }
      throw error;
    } finally {
      if (span) {
        toolSpans.delete(exec.token);
        try {
          span.end();
        } catch (error) {
          warn("Braintrust could not end a Harness tool span", error);
        }
      }
    }
  });

  ctx.effect(
    () => async () => {
      for (const sessionTurns of turns.values()) {
        for (const turn of sessionTurns.values()) {
          try {
            turn.span.end();
          } catch (error) {
            warn(
              "Braintrust could not close an unfinished Harness turn",
              error,
            );
          }
        }
      }
      turns.clear();
      activeTurns.clear();
      childParents.clear();
      toolSpans.clear();
      try {
        await flushPendingLogs();
        attachmentCache.clear();
        await logger.flush();
      } catch (error) {
        warn("Braintrust could not flush Harness traces", error);
      }
    },
    "braintrust: flush Harness traces",
  );
}
