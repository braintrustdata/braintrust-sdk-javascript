import { flueChannels } from "../instrumentation/plugins/flue-channels";
import type { IsoTracingChannelCollection } from "../isomorph";
import type {
  FlueCallHandle,
  FlueCallOptions,
  FlueContext,
  FlueEvent,
  FlueHarness,
  FlueSession,
  FlueSkillOptions,
  FlueTaskOptions,
} from "../vendor-sdk-types/flue";

const WRAPPED_FLUE_CONTEXT = Symbol.for("braintrust.flue.wrapped-context");
const WRAPPED_FLUE_HARNESS = Symbol.for("braintrust.flue.wrapped-harness");
const WRAPPED_FLUE_SESSION = Symbol.for("braintrust.flue.wrapped-session");
const SUBSCRIBED_FLUE_CONTEXT_EVENTS = Symbol.for(
  "braintrust.flue.subscribed-context-events",
);

type FlueContextRecord = FlueContext & Record<PropertyKey, unknown>;
type FlueHarnessRecord = FlueHarness & Record<PropertyKey, unknown>;
type FlueSessionRecord = FlueSession & Record<PropertyKey, unknown>;
type FlueOperationChannel =
  | typeof flueChannels.prompt
  | typeof flueChannels.skill
  | typeof flueChannels.task
  | typeof flueChannels.compact;
type FlueOperationTraceContext<TResult> = Parameters<
  FlueOperationChannel["tracePromise"]
>[1] &
  Partial<{
    error: Error;
    result: TResult;
  }>;

/**
 * Wraps a Flue context with Braintrust tracing. Context wrapping subscribes to
 * Flue's event stream and patches ctx.init() so returned harness sessions emit
 * operation diagnostics-channel events.
 */
export function wrapFlueContext<T>(ctx: T): T {
  if (!isPlausibleFlueContext(ctx)) {
    // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
    console.warn("Unsupported Flue context. Not wrapping.");
    return ctx;
  }

  const context = ctx as FlueContextRecord;
  subscribeFlueContextEvents(context);
  if (context[WRAPPED_FLUE_CONTEXT]) {
    return ctx;
  }

  const originalInit = context.init.bind(context);
  try {
    Object.defineProperty(context, WRAPPED_FLUE_CONTEXT, {
      configurable: false,
      enumerable: false,
      value: true,
    });
    Object.defineProperty(context, "init", {
      configurable: true,
      value: async function wrappedFlueInit(options: unknown) {
        const harness = await originalInit(options);
        return wrapFlueHarness(harness);
      },
      writable: true,
    });
  } catch {
    // Frozen/sealed contexts cannot be patched. Leave user behavior untouched.
  }

  return ctx;
}

/**
 * Wraps a Flue session with Braintrust tracing. Direct session wrapping traces
 * top-level prompt/skill/task/compact calls. Event-derived child spans require
 * context instrumentation through wrapFlueContext() or auto-instrumentation.
 */
export function wrapFlueSession<T>(session: T): T {
  if (!isPlausibleFlueSession(session)) {
    // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
    console.warn("Unsupported Flue session. Not wrapping.");
    return session;
  }

  return patchFlueSessionInPlace(session as FlueSessionRecord) as T;
}

export function subscribeFlueContextEvents(
  ctx: FlueContext,
): (() => void) | undefined {
  if (
    !ctx ||
    typeof ctx !== "object" ||
    typeof ctx.subscribeEvent !== "function"
  ) {
    return undefined;
  }

  const context = ctx as FlueContextRecord;
  if (context[SUBSCRIBED_FLUE_CONTEXT_EVENTS]) {
    return undefined;
  }

  try {
    const unsubscribe = ctx.subscribeEvent((event: FlueEvent) => {
      flueChannels.contextEvent.traceSync(() => undefined, {
        arguments: [event],
        context: ctx,
      } as never);
    });
    Object.defineProperty(context, SUBSCRIBED_FLUE_CONTEXT_EVENTS, {
      configurable: false,
      enumerable: false,
      value: true,
    });
    return unsubscribe;
  } catch {
    return undefined;
  }
}

export function wrapFlueHarness<T>(harness: T): T {
  if (!isPlausibleFlueHarness(harness)) {
    return harness;
  }

  const target = harness as FlueHarnessRecord;
  if (target[WRAPPED_FLUE_HARNESS]) {
    return harness;
  }

  const originalSession = target.session.bind(target);
  try {
    Object.defineProperty(target, WRAPPED_FLUE_HARNESS, {
      configurable: false,
      enumerable: false,
      value: true,
    });
    Object.defineProperty(target, "session", {
      configurable: true,
      value: async function wrappedFlueHarnessSession(
        name?: string,
        options?: unknown,
      ) {
        const session = await originalSession(name, options);
        return patchFlueSessionInPlace(session as FlueSessionRecord);
      },
      writable: true,
    });

    const sessions = target.sessions;
    if (sessions && typeof sessions === "object") {
      patchFlueSessionFactory(sessions, "get");
      patchFlueSessionFactory(sessions, "create");
    }
  } catch {
    // Frozen/sealed harnesses cannot be patched. Leave user behavior untouched.
  }

  return harness;
}

export function patchFlueSessionInPlace<T extends FlueSessionRecord>(
  session: T,
): T {
  if (session[WRAPPED_FLUE_SESSION]) {
    return session;
  }

  try {
    Object.defineProperty(session, WRAPPED_FLUE_SESSION, {
      configurable: false,
      enumerable: false,
      value: true,
    });

    patchCallHandleMethod(session, "prompt", flueChannels.prompt);
    patchCallHandleMethod(session, "skill", flueChannels.skill);
    patchCallHandleMethod(session, "task", flueChannels.task);
    patchCompact(session);
  } catch {
    // Frozen/sealed sessions cannot be patched. Leave user behavior untouched.
  }

  return session;
}

function patchFlueSessionFactory(
  sessions: Record<PropertyKey, unknown>,
  method: "get" | "create",
): void {
  const original = sessions[method];
  if (typeof original !== "function") {
    return;
  }

  const bound = original.bind(sessions);
  Object.defineProperty(sessions, method, {
    configurable: true,
    value: async function wrappedFlueSessionFactory(
      name?: string,
      options?: unknown,
    ) {
      const session = await bound(name, options);
      return patchFlueSessionInPlace(session as FlueSessionRecord);
    },
    writable: true,
  });
}

function patchCallHandleMethod(
  session: FlueSessionRecord,
  method: "prompt" | "skill" | "task",
  channel:
    | typeof flueChannels.prompt
    | typeof flueChannels.skill
    | typeof flueChannels.task,
): void {
  const original = session[method];
  if (typeof original !== "function") {
    return;
  }

  const bound = original.bind(session);
  Object.defineProperty(session, method, {
    configurable: true,
    value(
      input: string,
      options?: FlueCallOptions | FlueSkillOptions | FlueTaskOptions,
    ) {
      const args = [input, options] as never;
      const { originalResult, traced } = traceFlueOperation(channel, {
        context: {
          arguments: args,
          operation: method,
          session,
        } as never,
        run: () => bound(input, options),
      });
      return preserveCallHandle(originalResult, traced);
    },
    writable: true,
  });
}

function patchCompact(session: FlueSessionRecord): void {
  const original = session.compact;
  if (typeof original !== "function") {
    return;
  }

  const bound = original.bind(session);
  Object.defineProperty(session, "compact", {
    configurable: true,
    value() {
      const context = {
        arguments: [],
        operation: "compact",
        session,
      } as Parameters<typeof flueChannels.compact.tracePromise>[1];
      return flueChannels.compact.tracePromise(() => bound(), context);
    },
    writable: true,
  });
}

function traceFlueOperation<TResult>(
  channel: FlueOperationChannel,
  args: {
    context: Parameters<FlueOperationChannel["tracePromise"]>[1];
    run: () => PromiseLike<TResult>;
  },
): {
  originalResult: PromiseLike<TResult>;
  traced: Promise<TResult>;
} {
  const tracingChannel =
    channel.tracingChannel() as IsoTracingChannelCollection<
      FlueOperationTraceContext<TResult>
    >;
  const context = args.context as FlueOperationTraceContext<TResult>;

  let originalResult: PromiseLike<TResult>;
  let traced: Promise<TResult>;
  const run = () => {
    try {
      originalResult = args.run();
      tracingChannel.end?.publish(context);
    } catch (error) {
      context.error = normalizeError(error);
      tracingChannel.error?.publish(context);
      tracingChannel.end?.publish(context);
      throw error;
    }

    traced = Promise.resolve(originalResult).then(
      (result) => {
        context.result = result;
        tracingChannel.asyncStart?.publish(context);
        tracingChannel.asyncEnd?.publish(context);
        return result;
      },
      (error: unknown) => {
        context.error = normalizeError(error);
        tracingChannel.error?.publish(context);
        tracingChannel.asyncStart?.publish(context);
        tracingChannel.asyncEnd?.publish(context);
        throw error;
      },
    );
  };

  if (tracingChannel.start?.runStores) {
    tracingChannel.start.runStores(context, run);
  } else {
    tracingChannel.start?.publish(context);
    run();
  }

  return { originalResult: originalResult!, traced: traced! };
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function preserveCallHandle(
  originalHandle: unknown,
  traced: PromiseLike<unknown>,
): PromiseLike<unknown> {
  if (!isFlueCallHandle(originalHandle)) {
    return traced;
  }

  const handle = originalHandle;
  const wrapped = {
    get signal() {
      return handle.signal;
    },
    abort(reason?: unknown) {
      return handle.abort(reason);
    },
    then<TResult1 = unknown, TResult2 = never>(
      onfulfilled?:
        | ((value: unknown) => TResult1 | PromiseLike<TResult1>)
        | undefined
        | null,
      onrejected?:
        | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
        | undefined
        | null,
    ) {
      return traced.then(onfulfilled, onrejected);
    },
  } satisfies FlueCallHandle<unknown>;

  return wrapped;
}

function isPlausibleFlueContext(value: unknown): value is FlueContext {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { init?: unknown }).init === "function"
  );
}

function isPlausibleFlueHarness(value: unknown): value is FlueHarness {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { session?: unknown }).session === "function"
  );
}

function isPlausibleFlueSession(value: unknown): value is FlueSession {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { prompt?: unknown }).prompt === "function" &&
    typeof (value as { skill?: unknown }).skill === "function" &&
    typeof (value as { task?: unknown }).task === "function" &&
    typeof (value as { compact?: unknown }).compact === "function"
  );
}

function isFlueCallHandle(value: unknown): value is FlueCallHandle<unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { then?: unknown }).then === "function" &&
    typeof (value as { abort?: unknown }).abort === "function" &&
    "signal" in value
  );
}
