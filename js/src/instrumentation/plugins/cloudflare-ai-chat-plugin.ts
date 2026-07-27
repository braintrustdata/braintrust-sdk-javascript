import { BasePlugin } from "../core";
import type { ChannelMessage } from "../core/channel-definitions";
import type { IsoChannelHandlers, IsoTracingChannel } from "../../isomorph";
import {
  BRAINTRUST_CURRENT_SPAN_STORE,
  _internalGetGlobalState,
  startSpan,
  withCurrent,
} from "../../logger";
import type { CurrentSpanStore, Span } from "../../logger";
import { debugLogger } from "../../debug-logger";
import { SpanTypeAttribute } from "../../../util/index";
import type {
  CloudflareAIChatAgent,
  CloudflareAIChatMessage,
  CloudflareAIChatTurnCallback,
} from "../../vendor-sdk-types/cloudflare-ai-chat";
import { cloudflareAIChatChannels } from "./cloudflare-ai-chat-channels";
import { instrumentCloudflareAIChatResponseHook } from "./cloudflare-ai-chat-instrumentation";

type TurnChannel = typeof cloudflareAIChatChannels.runExclusiveChatTurn;
type ResponseChannel = typeof cloudflareAIChatChannels.onChatResponse;

type TurnState = {
  agent?: object;
  cleanupTimer?: ReturnType<typeof setTimeout>;
  depth: number;
  ended: boolean;
  input?: Record<string, unknown>[];
  key: string | symbol;
  pendingError?: unknown;
  responseObserved: boolean;
  settled: boolean;
  span: Span;
};

const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const RESPONSE_STATE_RETENTION_MS = 60_000;

export class CloudflareAIChatPlugin extends BasePlugin {
  private readonly activeStates = new Set<TurnState>();
  private readonly activeTurns = new WeakMap<
    object,
    Map<string | symbol, TurnState>
  >();
  private readonly eventStates = new WeakMap<object, TurnState>();

  protected onEnable(): void {
    this.subscribeToResponseHook();
    this.subscribeToTurnRunner();
  }

  protected onDisable(): void {
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.unsubscribers = [];

    for (const state of this.activeStates) {
      this.cleanupState(state);
    }
    this.activeStates.clear();
  }

  private subscribeToTurnRunner(): void {
    const tracingChannel =
      cloudflareAIChatChannels.runExclusiveChatTurn.tracingChannel() as IsoTracingChannel<
        ChannelMessage<TurnChannel>
      >;

    const unbindCurrentSpanStore = this.bindCurrentSpanStore(tracingChannel);
    const handlers: IsoChannelHandlers<ChannelMessage<TurnChannel>> = {
      start: (event) => {
        this.ensureEventState(event);
      },
      asyncEnd: (event) => {
        this.finishEvent(event);
      },
      error: (event) => {
        this.finishEvent(event, event.error);
      },
    };

    tracingChannel.subscribe(handlers);
    this.unsubscribers.push(() => {
      unbindCurrentSpanStore?.();
      tracingChannel.unsubscribe(handlers);
    });
  }

  private subscribeToResponseHook(): void {
    const tracingChannel =
      cloudflareAIChatChannels.onChatResponse.tracingChannel() as IsoTracingChannel<
        ChannelMessage<ResponseChannel>
      >;
    const handlers: IsoChannelHandlers<ChannelMessage<ResponseChannel>> = {
      start: (event) => {
        let state: TurnState | undefined;
        try {
          const agent = asObject(event.self);
          const result = event.arguments[0];
          state = agent
            ? this.findResponseState(
                agent,
                stringValue(ownValue(result, "requestId")),
              )
            : undefined;
          if (!state) {
            return;
          }
          state.responseObserved = true;

          const output = serializeMessage(ownValue(result, "message"));
          const status = stringValue(ownValue(result, "status"));
          const error = ownValue(result, "error");
          const input =
            ownValue(result, "continuation") === true
              ? state.input
              : serializeMessages(readProperty(agent, "messages"))?.filter(
                  (message) =>
                    typeof output?.id !== "string" || message.id !== output.id,
                );
          state.span.log({
            ...(input !== undefined ? { input } : {}),
            ...(output !== undefined ? { output } : {}),
            ...(status === "error" && error !== undefined ? { error } : {}),
          });
        } catch (error) {
          debugLogger.debug(
            "Failed to process @cloudflare/ai-chat response hook:",
            error,
          );
        } finally {
          if (state?.settled) {
            this.cleanupState(state);
          }
        }
      },
    };

    tracingChannel.subscribe(handlers);
    this.unsubscribers.push(() => tracingChannel.unsubscribe(handlers));
  }

  private bindCurrentSpanStore(
    tracingChannel: IsoTracingChannel<ChannelMessage<TurnChannel>>,
  ): (() => void) | undefined {
    const globalState = _internalGetGlobalState();
    const contextManager = globalState?.contextManager;
    const startChannel = tracingChannel.start;
    const currentSpanStore = contextManager
      ? (
          contextManager as {
            [BRAINTRUST_CURRENT_SPAN_STORE]?: CurrentSpanStore;
          }
        )[BRAINTRUST_CURRENT_SPAN_STORE]
      : undefined;

    if (!startChannel || !currentSpanStore || !contextManager) {
      return undefined;
    }

    startChannel.bindStore(currentSpanStore, (event) => {
      const state = this.ensureEventState(event);
      return state
        ? contextManager.wrapSpanForStore(state.span)
        : currentSpanStore.getStore();
    });

    return () => startChannel.unbindStore(currentSpanStore);
  }

  private ensureEventState(
    event: ChannelMessage<TurnChannel>,
  ): TurnState | undefined {
    const eventKey = event as object;
    const known = this.eventStates.get(eventKey);
    if (known) {
      return known;
    }

    try {
      const agent = asObject(event.self);
      const requestId = stringValue(event.arguments[0]);
      const key = requestId ?? Symbol("cloudflare-ai-chat-turn");
      const activeForAgent = agent ? this.getActiveTurns(agent) : undefined;
      const existing = activeForAgent?.get(key);
      const state =
        existing && !existing.settled
          ? existing
          : this.createTurnState(agent, key);

      if (existing && !existing.settled) {
        state.depth += 1;
      }
      this.eventStates.set(eventKey, state);
      this.bindTurnCallback(event, agent, state);

      if (agent) {
        instrumentCloudflareAIChatResponseHook(agent as CloudflareAIChatAgent);
      }
      return state;
    } catch (error) {
      debugLogger.debug(
        "Failed to start @cloudflare/ai-chat instrumentation:",
        error,
      );
      return undefined;
    }
  }

  private createTurnState(
    agent: object | undefined,
    key: string | symbol,
  ): TurnState {
    const span = startSpan({
      name: "AIChatAgent.onChatMessage",
      spanAttributes: { type: SpanTypeAttribute.TASK },
    });
    const state: TurnState = {
      agent,
      depth: 1,
      ended: false,
      key,
      responseObserved: false,
      settled: false,
      span,
    };
    this.activeStates.add(state);
    if (agent) {
      this.getActiveTurns(agent).set(key, state);
    }

    return state;
  }

  private bindTurnCallback(
    event: ChannelMessage<TurnChannel>,
    agent: object | undefined,
    state: TurnState,
  ): void {
    const callback = event.arguments[1];
    if (typeof callback !== "function") {
      return;
    }

    try {
      event.arguments[1] = function (
        this: unknown,
        ...args: unknown[]
      ): unknown {
        return withCurrent(state.span, () => {
          try {
            const input = serializeMessages(readProperty(agent, "messages"));
            if (input !== undefined && state.input === undefined) {
              state.input = input;
              state.span.log({ input });
            }
          } catch (error) {
            debugLogger.debug(
              "Failed to capture @cloudflare/ai-chat messages:",
              error,
            );
          }
          return Reflect.apply(callback, this, args);
        });
      } as CloudflareAIChatTurnCallback;
    } catch (error) {
      debugLogger.debug(
        "Failed to bind @cloudflare/ai-chat turn callback context:",
        error,
      );
    }
  }

  private finishEvent(
    event: ChannelMessage<TurnChannel>,
    error?: unknown,
  ): void {
    const eventKey = event as object;
    const state = this.eventStates.get(eventKey);
    if (!state || state.ended) {
      return;
    }
    this.eventStates.delete(eventKey);
    if (error !== undefined && state.pendingError === undefined) {
      state.pendingError = error;
    }
    state.depth -= 1;
    if (state.depth === 0) {
      state.settled = true;
      this.endState(state);
      if (state.responseObserved || error !== undefined) {
        this.cleanupState(state);
      } else {
        state.cleanupTimer = setTimeout(
          () => this.cleanupState(state),
          RESPONSE_STATE_RETENTION_MS,
        );
        if (
          typeof state.cleanupTimer === "object" &&
          state.cleanupTimer !== null &&
          "unref" in state.cleanupTimer &&
          typeof state.cleanupTimer.unref === "function"
        ) {
          state.cleanupTimer.unref();
        }
      }
    }
  }

  private endState(state: TurnState): void {
    if (state.ended) {
      return;
    }
    state.ended = true;
    try {
      if (state.pendingError !== undefined) {
        state.span.log({ error: state.pendingError });
      }
    } finally {
      state.span.end();
    }
  }

  private cleanupState(state: TurnState): void {
    if (state.cleanupTimer !== undefined) {
      clearTimeout(state.cleanupTimer);
      state.cleanupTimer = undefined;
    }
    try {
      this.endState(state);
    } finally {
      this.activeStates.delete(state);
      if (state.agent) {
        const activeForAgent = this.activeTurns.get(state.agent);
        if (activeForAgent?.get(state.key) === state) {
          activeForAgent.delete(state.key);
        }
      }
    }
  }

  private getActiveTurns(agent: object): Map<string | symbol, TurnState> {
    let turns = this.activeTurns.get(agent);
    if (!turns) {
      turns = new Map();
      this.activeTurns.set(agent, turns);
    }
    return turns;
  }

  private findResponseState(
    agent: object,
    requestId: string | undefined,
  ): TurnState | undefined {
    const turns = this.activeTurns.get(agent);
    if (!turns) {
      return undefined;
    }
    if (requestId !== undefined) {
      return turns.get(requestId);
    }
    const active = [...turns.values()];
    return active.length === 1 ? active[0] : undefined;
  }
}

function asObject(value: unknown): object | undefined {
  return value !== null &&
    (typeof value === "object" || typeof value === "function")
    ? value
    : undefined;
}

function readProperty(value: unknown, key: PropertyKey): unknown {
  const object = asObject(value);
  return object ? Reflect.get(object, key) : undefined;
}

function ownValue(value: unknown, key: PropertyKey): unknown {
  const object = asObject(value);
  if (!object) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function serializeMessages(
  value: unknown,
): Record<string, unknown>[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.flatMap((message) => {
    const serialized = serializeMessage(message);
    return serialized === undefined ? [] : [serialized];
  });
}

function serializeMessage(value: unknown): Record<string, unknown> | undefined {
  const message = asObject(value) as CloudflareAIChatMessage | undefined;
  if (!message) {
    return undefined;
  }

  const serialized: Array<[string, unknown]> = [];
  const id = ownValue(message, "id");
  const role = ownValue(message, "role");
  const parts = ownValue(message, "parts");
  if (typeof id === "string") {
    serialized.push(["id", id]);
  }
  if (typeof role === "string") {
    serialized.push(["role", role]);
  }
  const sanitizedParts = sanitizeLoggedValue(parts);
  if (sanitizedParts !== undefined) {
    serialized.push(["parts", sanitizedParts]);
  }
  return serialized.length > 0 ? Object.fromEntries(serialized) : undefined;
}

function sanitizeLoggedValue(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0,
): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  const object = asObject(value);
  if (!object || depth >= 20 || typeof value === "function") {
    return undefined;
  }
  if (seen.has(object)) {
    return "[Circular]";
  }
  seen.add(object);

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeLoggedValue(entry, seen, depth + 1));
  }

  const entries: Array<[string, unknown]> = [];
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(object),
  )) {
    if (
      BLOCKED_KEYS.has(key) ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      continue;
    }
    const sanitized = sanitizeLoggedValue(descriptor.value, seen, depth + 1);
    if (sanitized !== undefined) {
      entries.push([key, sanitized]);
    }
  }
  return Object.fromEntries(entries);
}
