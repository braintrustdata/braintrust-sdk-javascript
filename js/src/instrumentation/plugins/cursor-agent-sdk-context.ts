import { debugLogger } from "../../debug-logger";
import type { Span } from "../../logger";
import type { CursorSDKUsage } from "../../vendor-sdk-types/cursor-sdk";

/**
 * Session and turn ids observed from Agent SDK's public hook events.
 * The Cursor SDK spans stay the trace. These notes only attach ids and,
 * when the SDK run did not report usage, the turn's reported aggregate.
 */
export type CursorAgentSDKRunBinding = {
  agentId?: string;
  finalized: boolean;
  metadata: Record<string, unknown>;
  span: Span;
  usageLogged?: boolean;
};

type TurnNote = {
  sdkAgentId?: string;
  sessionId: string;
  turnId?: string;
};

type HookEvent = {
  data?: {
    cost?: { model?: string; totalUsd?: number };
    message?: string;
    requestId?: string;
    sdkAgentId?: string;
    status?: string;
    usage?: CursorSDKUsage;
  };
  sessionId?: string;
  turnId?: string;
  type?: string;
};

type HookContext = {
  session?: {
    id?: string;
    sdkAgentId?: string;
  };
};

const MAX_TRACKED_RUNS = 64;
const MAX_RUNS_PER_KEY = 8;
const MAX_TURN_NOTES = 128;

type ContextState = {
  notesBySession: Map<string, TurnNote>;
  runsByKey: Map<string, CursorAgentSDKRunBinding[]>;
};

// The hook file can import a different braintrust copy than the one the
// loader patched (ESM and CJS builds, or a bundled hook). Keep the state on
// globalThis so every copy sees the same runs.
const CONTEXT_STATE = Symbol.for("braintrust.cursor-agent-sdk.context");
const globalState = globalThis as typeof globalThis & {
  [CONTEXT_STATE]?: ContextState;
};
const contextState: ContextState = (globalState[CONTEXT_STATE] ??= {
  notesBySession: new Map(),
  runsByKey: new Map(),
});
const { notesBySession, runsByKey } = contextState;

export function resetCursorAgentSDKContext(): void {
  notesBySession.clear();
  runsByKey.clear();
}

export function bindCursorAgentSDKRun(run: CursorAgentSDKRunBinding): void {
  const agentId = run.agentId;
  if (!agentId) {
    return;
  }
  const list = runsByKey.get(agentId) ?? [];
  list.push(run);
  rememberRuns(agentId, list);
  const note = notesBySession.get(agentId);
  if (!note || run.metadata["agent_sdk.turn_id"]) {
    return;
  }
  const alreadyStamped = (runsByKey.get(agentId) ?? []).some(
    (existing) =>
      existing !== run &&
      note.turnId !== undefined &&
      existing.metadata["agent_sdk.turn_id"] === note.turnId,
  );
  if (!alreadyStamped) {
    applyTurnNote(run, note);
  }
}

export function cursorAgentSDKHookEvents(): {
  "agent.bound": (event: HookEvent, ctx: HookContext) => void;
  "turn.bound": (event: HookEvent, ctx: HookContext) => void;
  "turn.completed": (event: HookEvent, ctx: HookContext) => void;
  "turn.failed": (event: HookEvent, ctx: HookContext) => void;
  "turn.started": (event: HookEvent, ctx: HookContext) => void;
} {
  return guardHandlers({
    "agent.bound": (event, ctx) => {
      const sdkAgentId = event.data?.sdkAgentId;
      if (typeof sdkAgentId !== "string" || !sdkAgentId) {
        return;
      }
      const note = rememberTurn(event, ctx);
      note.sdkAgentId = sdkAgentId;
      rememberNote(sdkAgentId, note);
      const run = findRun(note);
      if (run) {
        applyTurnNote(run, note);
      }
    },
    "turn.bound": (event, ctx) => {
      const requestId = event.data?.requestId;
      if (typeof requestId !== "string" || !requestId) {
        return;
      }
      const note = rememberTurn(event, ctx);
      const run = findRun(note);
      if (!run || run.metadata["cursor_sdk.request_id"]) {
        return;
      }
      applyTurnNote(run, note);
      run.metadata["cursor_sdk.request_id"] = requestId;
      logToSpan(run.span, { metadata: { "cursor_sdk.request_id": requestId } });
    },
    "turn.completed": (event, ctx) => {
      const note = rememberTurn(event, ctx);
      const run = findRun(note);
      if (!run) {
        return;
      }
      applyTurnNote(run, note);
      applyReportedTurnUsage(run, event.data?.usage);
      applyReportedCost(run, event.data?.cost);
    },
    "turn.failed": (event, ctx) => {
      const note = rememberTurn(event, ctx);
      const run = findRun(note);
      if (!run) {
        return;
      }
      applyTurnNote(run, note);
      const status = event.data?.status;
      const metadata: Record<string, unknown> = {};
      if (status === "error" || status === "cancelled") {
        metadata["cursor_sdk.status"] = status;
        metadata["agent_sdk.turn_status"] = status;
      }
      const fields: {
        error?: Error;
        metadata?: Record<string, unknown>;
      } = {};
      if (Object.keys(metadata).length > 0) {
        fields.metadata = metadata;
      }
      if (typeof event.data?.message === "string" && event.data.message) {
        fields.error = new Error(event.data.message);
      }
      if (fields.error || fields.metadata) {
        logToSpan(run.span, fields);
      }
    },
    "turn.started": (event, ctx) => {
      const note = rememberTurn(event, ctx);
      const run = findRun(note);
      if (run) {
        applyTurnNote(run, note);
      }
    },
  });
}

/** Hook handlers run inside the Agent SDK. Tracing failures must not escape. */
function guardHandlers<
  T extends Record<string, (event: HookEvent, ctx: HookContext) => void>,
>(handlers: T): T {
  const guarded: Record<string, (event: HookEvent, ctx: HookContext) => void> =
    {};
  for (const [name, handler] of Object.entries(handlers)) {
    guarded[name] = (event, ctx) => {
      try {
        handler(event ?? {}, ctx ?? {});
      } catch (error) {
        debugLogger.error(`Error processing Cursor Agent SDK ${name}:`, error);
      }
    };
  }
  return guarded as T;
}

function logToSpan(span: Span, event: Parameters<Span["log"]>[0]): void {
  try {
    span.log(event);
  } catch (error) {
    debugLogger.error("Error logging Cursor Agent SDK hook event:", error);
  }
}

/**
 * Drop the live run closure once the span has finished. Later hook events
 * still see the span and metadata, without the transcript buffers.
 */
export function releaseCursorAgentSDKRun(
  run: CursorAgentSDKRunBinding | undefined,
): void {
  if (!run) {
    return;
  }
  const released: CursorAgentSDKRunBinding = {
    agentId: run.agentId,
    finalized: true,
    metadata: run.metadata,
    span: run.span,
    usageLogged: run.usageLogged,
  };
  for (const [key, list] of runsByKey) {
    const index = list.indexOf(run);
    if (index < 0) {
      continue;
    }
    const next = list.slice();
    next[index] = released;
    runsByKey.set(key, next);
  }
  evictFinishedRuns();
}

function rememberTurn(event: HookEvent, ctx: HookContext): TurnNote {
  const sessionId = ctx.session?.id || event.sessionId;
  if (!sessionId) {
    return { sessionId: "" };
  }
  const existing = notesBySession.get(sessionId);
  const note: TurnNote = {
    sdkAgentId: ctx.session?.sdkAgentId ?? existing?.sdkAgentId,
    sessionId,
    turnId: event.turnId ?? existing?.turnId,
  };
  rememberNote(sessionId, note);
  if (note.sdkAgentId) {
    rememberNote(note.sdkAgentId, note);
  }
  return note;
}

function findRun(note: TurnNote): CursorAgentSDKRunBinding | undefined {
  if (!note.sessionId && !note.sdkAgentId) {
    return undefined;
  }
  const candidates = uniqueRuns(note);
  if (note.turnId) {
    const stamped = [...candidates]
      .reverse()
      .find((run) => run.metadata["agent_sdk.turn_id"] === note.turnId);
    if (stamped) {
      return stamped;
    }
  }
  const open = candidates.filter((run) => !run.finalized);
  const unstamped = open.filter((run) => !run.metadata["agent_sdk.turn_id"]);
  if (unstamped.length > 0) {
    return unstamped[0];
  }
  return open[0];
}

function uniqueRuns(note: TurnNote): CursorAgentSDKRunBinding[] {
  const seen = new Set<CursorAgentSDKRunBinding>();
  const runs: CursorAgentSDKRunBinding[] = [];
  for (const key of [note.sdkAgentId, note.sessionId]) {
    if (!key) {
      continue;
    }
    for (const run of runsByKey.get(key) ?? []) {
      if (seen.has(run)) {
        continue;
      }
      seen.add(run);
      runs.push(run);
    }
  }
  return runs;
}

function applyTurnNote(run: CursorAgentSDKRunBinding, note: TurnNote): void {
  if (!note.sessionId) {
    return;
  }
  const metadata: Record<string, unknown> = {
    "agent_sdk.session_id": note.sessionId,
  };
  if (note.turnId) {
    metadata["agent_sdk.turn_id"] = note.turnId;
  }
  if (note.sdkAgentId) {
    metadata["cursor_sdk.agent_id"] = note.sdkAgentId;
  }
  Object.assign(run.metadata, metadata);
  logToSpan(run.span, { metadata });
  if (note.sdkAgentId && note.sdkAgentId !== run.agentId) {
    const list = runsByKey.get(note.sdkAgentId) ?? [];
    if (!list.includes(run)) {
      list.push(run);
      rememberRuns(note.sdkAgentId, list);
    }
  }
}

function rememberRuns(key: string, runs: CursorAgentSDKRunBinding[]): void {
  runsByKey.delete(key);
  runsByKey.set(key, capTrackedRuns(runs));
  evictFinishedRuns();
}

function capTrackedRuns(
  runs: CursorAgentSDKRunBinding[],
): CursorAgentSDKRunBinding[] {
  const openCount = runs.filter((run) => !run.finalized).length;
  let finishedBudget = Math.max(0, MAX_RUNS_PER_KEY - openCount);
  const kept: CursorAgentSDKRunBinding[] = [];
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index];
    if (!run) {
      continue;
    }
    if (!run.finalized) {
      kept.push(run);
      continue;
    }
    if (finishedBudget > 0) {
      kept.push(run);
      finishedBudget -= 1;
    }
  }
  kept.reverse();
  return kept;
}

function evictFinishedRuns(): void {
  if (runsByKey.size <= MAX_TRACKED_RUNS) {
    return;
  }
  for (const key of [...runsByKey.keys()]) {
    if (runsByKey.size <= MAX_TRACKED_RUNS) {
      return;
    }
    const runs = runsByKey.get(key) ?? [];
    if (runs.some((run) => !run.finalized)) {
      continue;
    }
    runsByKey.delete(key);
    notesBySession.delete(key);
  }
}

function rememberNote(key: string, note: TurnNote): void {
  notesBySession.delete(key);
  notesBySession.set(key, note);
  while (notesBySession.size > MAX_TURN_NOTES) {
    const oldest = notesBySession.keys().next().value;
    if (!oldest || oldest === key) {
      return;
    }
    notesBySession.delete(oldest);
  }
}

function applyReportedTurnUsage(
  run: CursorAgentSDKRunBinding,
  usage: CursorSDKUsage | undefined,
): void {
  if (!usage || run.usageLogged) {
    return;
  }
  const metrics = metricsFromCursorUsage(usage);
  if (!metrics) {
    return;
  }
  run.usageLogged = true;
  logToSpan(run.span, {
    metadata: { "cursor_sdk.usage_scope": "agent_sdk.turn" },
    metrics,
  });
}

function applyReportedCost(
  run: CursorAgentSDKRunBinding,
  cost: { model?: string; totalUsd?: number } | undefined,
): void {
  if (
    !cost ||
    typeof cost.totalUsd !== "number" ||
    !Number.isFinite(cost.totalUsd)
  ) {
    return;
  }
  const metadata: Record<string, unknown> = {
    "agent_sdk.reported_cost_usd": cost.totalUsd,
  };
  if (typeof cost.model === "string" && cost.model) {
    metadata["agent_sdk.cost_model"] = cost.model;
  }
  logToSpan(run.span, { metadata });
}

export function metricsFromCursorUsage(
  usage: CursorSDKUsage | undefined,
): Record<string, number> | undefined {
  if (!usage) {
    return undefined;
  }
  const metrics: Record<string, number> = {};
  const inputTokens = countOrUndefined(usage.inputTokens);
  const outputTokens = countOrUndefined(usage.outputTokens);
  const cacheReadTokens = countOrUndefined(usage.cacheReadTokens);
  const cacheWriteTokens = countOrUndefined(usage.cacheWriteTokens);
  const reasoningTokens = countOrUndefined(usage.reasoningTokens);
  if (
    inputTokens !== undefined ||
    cacheReadTokens !== undefined ||
    cacheWriteTokens !== undefined
  ) {
    metrics.prompt_tokens =
      (inputTokens ?? 0) + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0);
  }
  if (outputTokens !== undefined) {
    metrics.completion_tokens = outputTokens;
  }
  if (cacheReadTokens !== undefined) {
    metrics.prompt_cached_tokens = cacheReadTokens;
  }
  if (cacheWriteTokens !== undefined) {
    metrics.prompt_cache_creation_tokens = cacheWriteTokens;
  }
  if (reasoningTokens !== undefined) {
    metrics.completion_reasoning_tokens = reasoningTokens;
  }
  if (
    metrics.prompt_tokens !== undefined &&
    metrics.completion_tokens !== undefined
  ) {
    metrics.tokens = metrics.prompt_tokens + metrics.completion_tokens;
  } else if (
    metrics.prompt_tokens === undefined &&
    metrics.completion_tokens === undefined &&
    isCount(usage.totalTokens)
  ) {
    metrics.tokens = usage.totalTokens;
  }
  return Object.keys(metrics).length > 0 ? metrics : undefined;
}

export function addCursorUsage(
  total: CursorSDKUsage,
  usage: CursorSDKUsage,
): CursorSDKUsage {
  const next: CursorSDKUsage = { ...total };
  for (const key of [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "reasoningTokens",
    "totalTokens",
  ] as const) {
    const value = usage[key];
    if (!isCount(value)) {
      continue;
    }
    const current = next[key];
    next[key] = isCount(current) ? current + value : value;
  }
  return next;
}

function countOrUndefined(value: unknown): number | undefined {
  return isCount(value) ? value : undefined;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
