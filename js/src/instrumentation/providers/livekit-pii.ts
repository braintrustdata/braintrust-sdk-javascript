import iso from "#braintrust-platform";

/*
 * LiveKit's own PII rule for its telemetry (telemetry/redaction.js and pii.js
 * in @livekit/agents 1.9.x), so the trace omits exactly what LiveKit would.
 */

/** The span attribute with which LiveKit marks a span of a redacted job. */
export const REDACTION_ENABLED = "lk.redaction.enabled";

/** The text LiveKit substitutes for exception details when PII is not allowed. */
export const REDACTED_EXCEPTION_MESSAGE = "exception details redacted";

const PII_SEGMENT = /(^|\.)pii(\.|$)/i;
// Flagged by the gen_ai semantic conventions as likely to contain user data.
const GEN_AI_PII_ATTRIBUTES = new Set([
  "gen_ai.input.messages",
  "gen_ai.output.messages",
  "gen_ai.system_instructions",
  "gen_ai.tool.call.arguments",
  "gen_ai.tool.call.result",
  "gen_ai.tool.description",
  "gen_ai.tool.definitions",
  "gen_ai.retrieval.query.text",
  "gen_ai.retrieval.documents",
  "gen_ai.memory.query.text",
  "gen_ai.memory.records",
  "gen_ai.evaluation.explanation",
]);
const PII_EVENTS = new Set([
  "gen_ai.system.message",
  "gen_ai.user.message",
  "gen_ai.assistant.message",
  "gen_ai.tool.message",
  "gen_ai.choice",
  "gen_ai.client.inference.operation.details",
]);
const EXCEPTION_MESSAGE = "exception.message";
const EXCEPTION_STACKTRACE = "exception.stacktrace";
const FALSY = new Set(["0", "false", "no", "off"]);

/**
 * Whether LiveKit's configuration allows PII in its telemetry: allowed unless
 * LIVEKIT_TELEMETRY_ALLOW_PII is falsy, or the job enables LiveKit Cloud
 * project redaction (which wins over the environment).
 */
export function livekitPiiAllowed(job?: { _redactionEnabled?: boolean }) {
  if (job?._redactionEnabled) return false;
  const allow = iso.getEnv("LIVEKIT_TELEMETRY_ALLOW_PII");
  return allow === undefined || !FALSY.has(allow.trim().toLowerCase());
}

export function isPiiEvent(name: string): boolean {
  return PII_EVENTS.has(name);
}

/** Native attributes without PII, and with exception details replaced, as LiveKit does. */
export function withoutPii(
  attributes: Iterable<[string, unknown]>,
): Map<string, unknown> {
  const kept = new Map<string, unknown>();
  for (const [key, value] of attributes) {
    if (key === EXCEPTION_MESSAGE) kept.set(key, REDACTED_EXCEPTION_MESSAGE);
    else if (
      key !== EXCEPTION_STACKTRACE &&
      !PII_SEGMENT.test(key) &&
      !GEN_AI_PII_ATTRIBUTES.has(key) &&
      !key.startsWith("gen_ai.prompt.variable")
    )
      kept.set(key, value);
  }
  return kept;
}
