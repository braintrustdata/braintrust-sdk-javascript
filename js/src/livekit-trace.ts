import { SpanTypeAttribute } from "../util";
import { debugLogger } from "./debug-logger";
import { liveKitMessages } from "./instrumentation/plugins/livekit-agents-data";
import {
  _internalStartSpanWithInitialMerge,
  NOOP_SPAN,
  updateSpan,
  withCurrent,
  type Span,
} from "./logger";
import {
  INSTRUMENTATION_NAMES,
  withSpanInstrumentationName,
} from "./span-origin";
import { getCurrentUnixTimestamp } from "./util";
import type { LiveKitChatContext } from "./vendor-sdk-types/livekit-agents";

type Messages = string | ReadonlyArray<LiveKitChatContext["items"][number]>;
type StartOptions = {
  parent?: Span | string;
  sessionId?: string;
  input?: Messages;
  /** Unix time in seconds. Defaults to now. */
  startTime?: number;
};
type TurnOptions = StartOptions & {
  parent: Span | string;
  operation: "generateReply" | "say" | "run" | "voice";
  speechId?: string;
};
type CaptureOptions = {
  /** The span, or the string returned by its `export()` method. */
  span: Span | string;
  status: "pending" | "completed" | "interrupted" | "cancelled" | "failed";
  sessionId?: string;
  speechId?: string;
  input?: Messages;
  output?: Messages;
  error?: Error | string;
  /** Unix time in seconds. Only used for terminal statuses. Defaults to now. */
  endTime?: number;
};

function toMessages(
  value: Messages | undefined,
  role: "user" | "assistant",
): unknown[] | undefined {
  if (value === undefined) return undefined;
  // Only accept snapshots. Never await, iterate, or call into SDK objects.
  if (typeof value !== "string" && !Array.isArray(value)) {
    debugLogger.warn("LiveKit capture requires text or a chat-item array");
    return undefined;
  }
  try {
    return liveKitMessages(
      {
        items:
          typeof value === "string"
            ? [{ type: "message", role, content: [value] }]
            : [...value],
      },
      false,
    );
  } catch (error) {
    debugLogger.warn("Cannot normalize LiveKit capture messages", error);
    return undefined;
  }
}

function startTrace(
  kind: "session" | "turn",
  options: StartOptions | TurnOptions,
): Span {
  const { parent } = options;
  const start = () =>
    _internalStartSpanWithInitialMerge(
      withSpanInstrumentationName(
        {
          name: `livekit.${kind}`,
          type: SpanTypeAttribute.TASK,
          parent: typeof parent === "string" ? parent : undefined,
          startTime: options.startTime,
          event: {
            input: toMessages(options.input, "user"),
            metadata: {
              status: "pending",
              session_id: options.sessionId,
              operation: "operation" in options ? options.operation : undefined,
              speech_id: "speechId" in options ? options.speechId : undefined,
            },
          },
        },
        INSTRUMENTATION_NAMES.LIVEKIT_AGENTS,
      ),
    );
  try {
    // Span parents are only made current while the span is created.
    return typeof parent === "object" ? withCurrent(parent, start) : start();
  } catch (error) {
    debugLogger.warn("Cannot start LiveKit capture", error);
    return NOOP_SPAN;
  }
}

/**
 * Start a span for a LiveKit session. This does not operate the session or
 * change the current span; report outcomes with `captureLiveKitTrace`.
 *
 * @example
 * ```ts
 * const trace = startLiveKitSessionTrace({ sessionId: "my-session" });
 * await withCurrent(trace, () => session.start({ agent }));
 * // ...
 * await session.close();
 * captureLiveKitTrace({ span: trace, status: "completed", output: session.history.items });
 * ```
 */
export function startLiveKitSessionTrace(options: StartOptions = {}): Span {
  return startTrace("session", options);
}

/**
 * Start a span for a LiveKit turn. This does not make the span current; wrap
 * the calls that belong to the turn with `withCurrent` to parent their spans.
 * For voice turns, call this from a `speech_created` listener.
 *
 * @example
 * ```ts
 * const turn = startLiveKitTurnTrace({ parent: sessionTrace, operation: "generateReply", input: "Hello" });
 * const handle = withCurrent(turn, () => session.generateReply({ userInput: "Hello" }));
 * await handle.waitForPlayout();
 * captureLiveKitTrace({ span: turn, speechId: handle.id, status: handle.interrupted ? "interrupted" : "completed", output: handle.chatItems });
 * ```
 */
export function startLiveKitTurnTrace(options: TurnOptions): Span {
  return startTrace("turn", options);
}

/**
 * Record a session or turn outcome. Messages replace previously captured
 * values. A `pending` status keeps the span open; any other status ends it.
 *
 * To report from another process, pass the string from `span.export()` and
 * flush the original span first. Repeated captures update the same span.
 */
export function captureLiveKitTrace(options: CaptureOptions): void {
  const { span, status, endTime } = options;
  const event = {
    input: toMessages(options.input, "user"),
    output: toMessages(options.output, "assistant"),
    error: options.error,
    metadata: {
      status,
      session_id: options.sessionId,
      speech_id: options.speechId,
    },
  };
  if (typeof span !== "string") {
    span.log(event);
    if (status !== "pending") span.end({ endTime });
    return;
  }
  // NOOP_SPAN exports an empty string when logging is disabled.
  if (!span) return;
  try {
    updateSpan({
      exported: span,
      ...event,
      metrics:
        status === "pending"
          ? undefined
          : { end: endTime ?? getCurrentUnixTimestamp() },
    });
  } catch (error) {
    debugLogger.warn("Cannot resume LiveKit capture", error);
  }
}
