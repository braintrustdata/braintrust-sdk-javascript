import iso from "../../isomorph";
import type { IsoAsyncLocalStorage, IsoTracingChannel } from "../../isomorph";
import {
  _internalGetGlobalState,
  currentSpan,
  startSpan,
  updateSpan,
  type Span,
  type StartSpanArgs,
} from "../../logger";
import {
  INSTRUMENTATION_NAMES,
  withSpanInstrumentationName,
} from "../../span-origin";
import { getCurrentUnixTimestamp, isObject } from "../../util";
import type {
  AISDKHarnessAgentCreateSessionParams,
  AISDKHarnessAgentSession,
} from "../../vendor-sdk-types/ai-sdk";
import { SpanComponentsV4 } from "../../../util/span_identifier_v4";

const BRAINTRUST_TURN_CONTEXT_KEY = "__braintrust_trace_context";

export type HarnessTurnParent = Span | string;

type HarnessTurnContext = {
  parent: string;
  sessionId: string;
};

type SerializedHarnessTurnContext = HarnessTurnContext & {
  signature: string;
};

type HarnessTurnUpdate = Parameters<Span["log"]>[0];

type LifecycleMethod = "detach" | "stop" | "suspendTurn";

const sessionTurnParents = new WeakMap<object, HarnessTurnParent>();
const wrapperTurnParents = new WeakMap<Span, HarnessTurnParent>();
const patchedLifecycleMethods = new WeakMap<object, Set<LifecycleMethod>>();
let harnessTurnParentStore:
  | IsoAsyncLocalStorage<HarnessTurnParent | undefined>
  | undefined;

function serializedTurnContext(value: unknown): HarnessTurnContext | undefined {
  if (!isObject(value)) {
    return undefined;
  }

  const context = value[BRAINTRUST_TURN_CONTEXT_KEY];
  if (
    !isObject(context) ||
    typeof context.parent !== "string" ||
    typeof context.sessionId !== "string" ||
    typeof context.signature !== "string"
  ) {
    return undefined;
  }

  const expectedSignature = signTurnContext({
    parent: context.parent,
    sessionId: context.sessionId,
  });
  if (
    !expectedSignature ||
    !iso.timingSafeEqual?.(context.signature, expectedSignature)
  ) {
    return undefined;
  }

  const parent = SpanComponentsV4.fromStr(context.parent);
  if (
    !parent.data.row_id ||
    !parent.data.root_span_id ||
    !parent.data.span_id
  ) {
    return undefined;
  }

  return {
    parent: context.parent,
    sessionId: context.sessionId,
  };
}

function signTurnContext(context: HarnessTurnContext): string | undefined {
  const secret =
    _internalGetGlobalState()._internalGetTraceContextSigningSecret();
  return secret
    ? iso.hmacSha256?.(
        secret,
        JSON.stringify([BRAINTRUST_TURN_CONTEXT_KEY, context]),
      )
    : undefined;
}

function continuationParentFromCreateSessionParams(
  params: AISDKHarnessAgentCreateSessionParams | undefined,
): HarnessTurnParent | undefined {
  if (!isObject(params)) {
    return undefined;
  }

  const continuation =
    params.continueFrom ??
    (isObject(params.resumeFrom) ? params.resumeFrom.continueFrom : undefined);
  const context = serializedTurnContext(continuation);
  if (!context) {
    return undefined;
  }

  if (params.sessionId !== context.sessionId) {
    return undefined;
  }

  return context.parent;
}

function exportSpanSynchronously(span: Span): string | undefined {
  const parentInfo = span.getParentInfo();
  if (!parentInfo) {
    return undefined;
  }
  const objectId = parentInfo.objectId.getSync().value;
  if (!objectId && !parentInfo.computeObjectMetadataArgs) {
    return undefined;
  }

  return new SpanComponentsV4({
    object_type: parentInfo.objectType,
    ...(objectId
      ? { object_id: objectId }
      : {
          compute_object_metadata_args:
            parentInfo.computeObjectMetadataArgs ?? {},
        }),
    row_id: span.id,
    root_span_id: span.rootSpanId,
    span_id: span.spanId,
  }).toStr();
}

function exportedParent(parent: HarnessTurnParent): string | undefined {
  return typeof parent === "string" ? parent : exportSpanSynchronously(parent);
}

function addSerializedContext(args: {
  continuation: unknown;
  parent: HarnessTurnParent;
  sessionId: string | undefined;
}): void {
  if (!isObject(args.continuation) || args.sessionId === undefined) {
    return;
  }

  const parent = exportedParent(args.parent);
  if (!parent) {
    return;
  }
  const context = {
    parent,
    sessionId: args.sessionId,
  };
  const signature = signTurnContext(context);
  if (!signature) {
    return;
  }
  Object.defineProperty(args.continuation, BRAINTRUST_TURN_CONTEXT_KEY, {
    configurable: true,
    enumerable: true,
    value: {
      ...context,
      signature,
    } satisfies SerializedHarnessTurnContext,
    writable: true,
  });
}

function lifecycleMethodDescriptor(
  session: object,
  method: LifecycleMethod,
): { descriptor: PropertyDescriptor; owner: object } | undefined {
  let owner: object | null = session;
  while (owner) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, method);
    if (descriptor) {
      return { descriptor, owner };
    }
    owner = Object.getPrototypeOf(owner);
  }
  return undefined;
}

function patchLifecycleMethod(
  session: AISDKHarnessAgentSession,
  method: LifecycleMethod,
): void {
  let resolvedDescriptor:
    | { descriptor: PropertyDescriptor; owner: object }
    | undefined;
  try {
    resolvedDescriptor = lifecycleMethodDescriptor(session, method);
  } catch {
    return;
  }
  if (
    !resolvedDescriptor ||
    !("value" in resolvedDescriptor.descriptor) ||
    typeof resolvedDescriptor.descriptor.value !== "function"
  ) {
    return;
  }

  const { descriptor, owner } = resolvedDescriptor;
  const patched = patchedLifecycleMethods.get(owner);
  if (patched?.has(method)) {
    return;
  }

  const original = descriptor.value;
  const replacement = function (
    this: AISDKHarnessAgentSession,
    ...args: unknown[]
  ) {
    const result = Reflect.apply(original, this, args);
    const addContext = (state: unknown) => {
      try {
        const parent = sessionTurnParents.get(this);
        if (!parent) {
          return;
        }
        const continuation =
          method === "suspendTurn"
            ? state
            : isObject(state)
              ? state.continueFrom
              : undefined;
        addSerializedContext({
          continuation,
          parent,
          sessionId:
            typeof this.sessionId === "string" ? this.sessionId : undefined,
        });
      } catch {
        // Lifecycle state is caller-visible. Instrumentation must never alter
        // the method's result or rejection behavior when context injection fails.
      }
    };

    try {
      if (isObject(result) && typeof result.then === "function") {
        void Promise.resolve(result).then(addContext, () => {});
      } else {
        addContext(result);
      }
    } catch {
      // Promise and thenable inspection is instrumentation-only.
    }
    return result;
  };

  try {
    Object.defineProperty(owner, method, {
      ...descriptor,
      value: replacement,
    });
    const ownerMethods = patched ?? new Set<LifecycleMethod>();
    ownerMethods.add(method);
    if (!patched) {
      patchedLifecycleMethods.set(owner, ownerMethods);
    }
  } catch {
    // A frozen owner cannot be patched. The lifecycle API remains untouched.
  }
}

function patchLifecycleMethods(session: AISDKHarnessAgentSession): void {
  patchLifecycleMethod(session, "suspendTurn");
  patchLifecycleMethod(session, "detach");
  patchLifecycleMethod(session, "stop");
}

export function registerHarnessTurnSpan(args: {
  session: unknown;
  span: Span;
}): void {
  if (!isObject(args.session)) {
    return;
  }
  const session: AISDKHarnessAgentSession = args.session;

  sessionTurnParents.set(session, args.span);
  wrapperTurnParents.set(args.span, args.span);
  patchLifecycleMethods(session);
}

export function harnessContinuationParent(
  session: unknown,
): HarnessTurnParent | undefined {
  return isObject(session) ? sessionTurnParents.get(session) : undefined;
}

export function captureHarnessCreateSessionParent(
  params: AISDKHarnessAgentCreateSessionParams | undefined,
): HarnessTurnParent | undefined {
  try {
    return continuationParentFromCreateSessionParams(params);
  } catch {
    // Continuation state is caller-controlled. Revoked proxies, cycles, and
    // throwing getters must not affect createSession().
    return undefined;
  }
}

export function registerHarnessSessionParent(
  session: unknown,
  parent: HarnessTurnParent | undefined,
): void {
  if (!parent || !isObject(session)) {
    return;
  }

  const harnessSession: AISDKHarnessAgentSession = session;
  sessionTurnParents.set(harnessSession, parent);
  patchLifecycleMethods(harnessSession);
}

export function currentHarnessTurnParent(): HarnessTurnParent | undefined {
  return (
    harnessTurnParentStore?.getStore() ?? wrapperTurnParents.get(currentSpan())
  );
}

export function bindHarnessTurnParentToStart<T>(
  tracingChannel: IsoTracingChannel<T>,
  parentFromEvent: (event: T) => HarnessTurnParent | undefined,
): () => void {
  const startChannel = tracingChannel.start;
  if (!startChannel) {
    return () => {};
  }

  harnessTurnParentStore ??= iso.newAsyncLocalStorage<
    HarnessTurnParent | undefined
  >();
  const store = harnessTurnParentStore;
  startChannel.bindStore(
    store,
    (event) => parentFromEvent(event) ?? store.getStore(),
  );
  return () => {
    startChannel.unbindStore(store);
  };
}

export function startHarnessTurnChildSpan(
  parent: HarnessTurnParent,
  args: StartSpanArgs,
): Span {
  const spanArgs = withSpanInstrumentationName(
    args,
    INSTRUMENTATION_NAMES.AI_SDK,
  );
  return typeof parent === "string"
    ? startSpan({ ...spanArgs, parent })
    : parent.startSpan(spanArgs);
}

export function updateHarnessTurn(
  parent: HarnessTurnParent | undefined,
  update: HarnessTurnUpdate = {},
): void {
  if (!parent) {
    return;
  }

  const log = (event: HarnessTurnUpdate) => {
    if (typeof parent === "string") {
      updateSpan({ exported: parent, ...event });
    } else {
      parent.log(event);
    }
  };

  try {
    if (Object.prototype.hasOwnProperty.call(update, "output")) {
      // Span updates deep-merge objects. Clear the suspended partial output so
      // the continuation's final output replaces it.
      log({ output: null });
    }
    log(update);
  } catch {
    // Logging failures must not affect the agent call.
  }
}

export function endHarnessTurn(parent: HarnessTurnParent | undefined): number {
  const endTime = getCurrentUnixTimestamp();
  if (!parent) {
    return endTime;
  }

  try {
    const event = { metrics: { end: endTime } };
    if (typeof parent === "string") {
      updateSpan({ exported: parent, ...event });
    } else {
      // The original task was already ended when it suspended. Span.end()
      // retains that first timestamp, so explicitly extend its end metric.
      parent.log(event);
    }
  } catch {
    // Logging failures must not affect the agent call.
  }
  return endTime;
}
