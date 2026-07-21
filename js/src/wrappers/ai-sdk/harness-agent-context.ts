import {
  currentSpan,
  startSpan,
  updateSpan,
  type Span,
  type StartSpanArgs,
} from "../../logger";
import { getCurrentUnixTimestamp, isObject } from "../../util";
import type { AISDKHarnessAgentCreateSessionParams } from "../../vendor-sdk-types/ai-sdk";

const BRAINTRUST_TURN_CONTEXT_KEY = "__braintrust_trace_context";

type HarnessTurnParent = Span | string;

type SerializedHarnessTurnContext = {
  parent: string;
  version: 1;
};

const sessionTurnParents = new WeakMap<object, HarnessTurnParent>();
const wrapperTurnParents = new WeakMap<Span, HarnessTurnParent>();
const patchedSessions = new WeakSet<object>();

function serializedTurnParent(value: unknown): string | undefined {
  if (!isObject(value)) {
    return undefined;
  }

  const context = value[BRAINTRUST_TURN_CONTEXT_KEY];
  if (
    !isObject(context) ||
    context.version !== 1 ||
    typeof context.parent !== "string"
  ) {
    return undefined;
  }

  return context.parent;
}

function continuationParentFromCreateSessionParams(
  params: AISDKHarnessAgentCreateSessionParams | undefined,
): string | undefined {
  if (!isObject(params)) {
    return undefined;
  }

  return (
    serializedTurnParent(params.continueFrom) ??
    (isObject(params.resumeFrom)
      ? serializedTurnParent(params.resumeFrom.continueFrom)
      : undefined)
  );
}

async function exportedParent(parent: HarnessTurnParent): Promise<string> {
  return typeof parent === "string" ? parent : await parent.export();
}

function patchSuspendTurn(session: Record<string, unknown>): void {
  if (
    patchedSessions.has(session) ||
    typeof session.suspendTurn !== "function"
  ) {
    return;
  }

  const originalSuspendTurn = session.suspendTurn;
  const patchedSuspendTurn = async function (
    this: Record<string, unknown>,
    ...args: unknown[]
  ): Promise<unknown> {
    const continuation = await Reflect.apply(originalSuspendTurn, this, args);
    const parent =
      sessionTurnParents.get(this) ?? sessionTurnParents.get(session);
    if (!parent || !isObject(continuation)) {
      return continuation;
    }

    const context: SerializedHarnessTurnContext = {
      parent: await exportedParent(parent),
      version: 1,
    };
    return {
      ...continuation,
      [BRAINTRUST_TURN_CONTEXT_KEY]: context,
    };
  };

  try {
    if (Reflect.set(session, "suspendTurn", patchedSuspendTurn)) {
      patchedSessions.add(session);
    }
  } catch {
    // A frozen or custom session may not permit method replacement. Turn
    // tracing still works, but it cannot be correlated across serialization.
  }
}

export function registerHarnessTurnSpan(args: {
  continuation: boolean;
  session: unknown;
  span: Span;
}): void {
  if (!isObject(args.session)) {
    return;
  }

  if (args.continuation) {
    const parent = sessionTurnParents.get(args.session);
    if (parent) {
      wrapperTurnParents.set(args.span, parent);
    }
    return;
  }

  sessionTurnParents.set(args.session, args.span);
  wrapperTurnParents.set(args.span, args.span);
  patchSuspendTurn(args.session);
}

export function harnessContinuationParent(
  session: unknown,
): HarnessTurnParent | undefined {
  return isObject(session) ? sessionTurnParents.get(session) : undefined;
}

export function captureHarnessCreateSessionParent(
  params: AISDKHarnessAgentCreateSessionParams | undefined,
): string | undefined {
  return continuationParentFromCreateSessionParams(params);
}

export function registerHarnessSessionParent(
  session: unknown,
  parent: string | undefined,
): void {
  if (!parent || !isObject(session)) {
    return;
  }

  sessionTurnParents.set(session, parent);
  patchSuspendTurn(session);
}

export function currentHarnessTurnParent(): HarnessTurnParent | undefined {
  return wrapperTurnParents.get(currentSpan());
}

export function startHarnessTurnChildSpan(
  parent: HarnessTurnParent,
  args: StartSpanArgs,
): Span {
  return typeof parent === "string"
    ? startSpan({ ...args, parent })
    : parent.startSpan(args);
}

export function extendHarnessTurn(parent: HarnessTurnParent | undefined): void {
  if (!parent) {
    return;
  }

  const event = { metrics: { end: getCurrentUnixTimestamp() } };
  try {
    if (typeof parent === "string") {
      updateSpan({ exported: parent, ...event });
    } else {
      parent.log(event);
    }
  } catch {
    // Invalid or stale propagated context must not affect the agent call.
  }
}
