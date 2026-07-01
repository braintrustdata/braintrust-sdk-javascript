// ID generation system for Braintrust spans
// Supports both UUID and OpenTelemetry-compatible (hex) ID formats.
//
// By default the SDK generates OpenTelemetry-compatible hex IDs (16-byte trace
// id / 8-byte span id) which can be propagated via W3C Trace Context. Setting
// BRAINTRUST_LEGACY_IDS opts back into the legacy UUID-based IDs.

import { v4 as uuidv4 } from "uuid";
import { debugLogger } from "./debug-logger";
import iso from "./isomorph";

/**
 * Abstract base class for ID generators
 */
export abstract class IDGenerator {
  /**
   * Generate a span ID
   */
  abstract getSpanId(): string;

  /**
   * Generate a trace ID
   */
  abstract getTraceId(): string;

  /**
   * Return true if the generator should use span_id as root_span_id for backwards compatibility
   */
  abstract shareRootSpanId(): boolean;
}

/**
 * ID generator that uses UUID4 for both span and trace IDs
 */
export class UUIDGenerator extends IDGenerator {
  getSpanId(): string {
    return uuidv4();
  }

  getTraceId(): string {
    return uuidv4();
  }

  shareRootSpanId(): boolean {
    return true;
  }
}

function generateHexId(bytes: number): string {
  let result = "";
  for (let i = 0; i < bytes; i++) {
    result += Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, "0");
  }
  return result;
}

/**
 * ID generator that produces OpenTelemetry-compatible hex IDs.
 *
 * Span IDs are 8 random bytes (16 hex chars) and trace IDs are 16 random bytes
 * (32 hex chars), matching the W3C Trace Context / OpenTelemetry shape. Trace
 * ids are distinct from span ids (root_span_id is a separate trace id, not the
 * root span's id), so `shareRootSpanId()` returns false.
 */
export class OTELIDGenerator extends IDGenerator {
  getSpanId(): string {
    // Generate 8 random bytes and convert to hex (16 characters)
    return generateHexId(8);
  }

  getTraceId(): string {
    // Generate 16 random bytes and convert to hex (32 characters)
    return generateHexId(16);
  }

  shareRootSpanId(): boolean {
    return false;
  }
}

/**
 * Parse a boolean environment variable. Accepts common truthy/falsey spellings;
 * unset or unrecognized values are treated as false.
 */
function parseEnvBool(name: string): boolean {
  const raw = iso.getEnv(name);
  if (raw === undefined || raw === null) {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  return (
    normalized === "true" ||
    normalized === "1" ||
    normalized === "yes" ||
    normalized === "y" ||
    normalized === "on"
  );
}

let _warnedLegacyUuidConflict = false;

/**
 * Resolve whether the SDK should generate legacy UUID-based span/trace IDs.
 *
 * The default is OpenTelemetry-compatible hex IDs (16-byte trace id / 8-byte
 * span id) with V4 span-component export. Setting BRAINTRUST_LEGACY_IDS opts
 * back into UUID IDs with V3 export.
 *
 * BRAINTRUST_OTEL_COMPAT (which selects the OpenTelemetry context manager)
 * requires hex IDs, so it always wins: if both it and BRAINTRUST_LEGACY_IDS are
 * set, legacy IDs are disabled and a warning is logged (at most once per
 * process, even though this is re-resolved lazily on each access).
 */
export function resolveUseLegacyUuidIds(): boolean {
  const legacy = parseEnvBool("BRAINTRUST_LEGACY_IDS");
  if (parseEnvBool("BRAINTRUST_OTEL_COMPAT")) {
    if (legacy && !_warnedLegacyUuidConflict) {
      _warnedLegacyUuidConflict = true;
      debugLogger.warn(
        "BRAINTRUST_LEGACY_IDS is ignored because BRAINTRUST_OTEL_COMPAT " +
          "requires OpenTelemetry-compatible hex span IDs. Using hex IDs.",
      );
    }
    return false;
  }
  return legacy;
}

/**
 * Factory function that creates a new ID generator instance each time.
 *
 * This eliminates global state and makes tests parallelizable.
 * Each caller gets their own generator instance.
 *
 * Honors an explicitly-installed `globalThis.BRAINTRUST_ID_GENERATOR` (e.g. set
 * by `@braintrust/otel`'s `setupOtelCompat()`). Otherwise it defaults to
 * OpenTelemetry-compatible hex IDs, falling back to legacy UUID IDs when
 * BRAINTRUST_LEGACY_IDS is set.
 */
export function getIdGenerator(): IDGenerator {
  if (globalThis.BRAINTRUST_ID_GENERATOR !== undefined) {
    return new globalThis.BRAINTRUST_ID_GENERATOR();
  }
  return resolveUseLegacyUuidIds()
    ? new UUIDGenerator()
    : new OTELIDGenerator();
}
