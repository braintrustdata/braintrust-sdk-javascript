import type { RecordedRequest } from "./cassette";

/**
 * Thrown when `replay` mode encounters a request that doesn't match any
 * recorded entry. Includes the request and cassette name so callers can
 * diagnose the miss without parsing error messages.
 */
export class CassetteMissError extends Error {
  readonly request: RecordedRequest;
  readonly cassetteName: string;
  readonly matchKey: string;

  constructor(args: {
    request: RecordedRequest;
    cassetteName: string;
    matchKey: string;
    message?: string;
  }) {
    super(
      args.message ??
        `Cassette miss for ${args.matchKey} in cassette "${args.cassetteName}". ` +
          `Re-run with mode='record' to capture this interaction.`,
    );
    this.name = "CassetteMissError";
    this.request = args.request;
    this.cassetteName = args.cassetteName;
    this.matchKey = args.matchKey;
  }
}

/**
 * Thrown when a cassette file's `version` field is newer than this library
 * supports. Catching this and pointing the user at an upgrade is more useful
 * than silently downgrading.
 */
export class CassetteVersionError extends Error {
  readonly cassetteName: string;
  readonly foundVersion: number;
  readonly supportedVersion: number;

  constructor(args: {
    cassetteName: string;
    foundVersion: number;
    supportedVersion: number;
  }) {
    super(
      `Cassette "${args.cassetteName}" has version ${args.foundVersion}, ` +
        `but this version of seinfeld supports up to version ${args.supportedVersion}. ` +
        `Upgrade seinfeld to read this cassette.`,
    );
    this.name = "CassetteVersionError";
    this.cassetteName = args.cassetteName;
    this.foundVersion = args.foundVersion;
    this.supportedVersion = args.supportedVersion;
  }
}

/** Thrown when a cassette file fails schema validation. */
export class CassetteFormatError extends Error {
  readonly cassetteName: string;

  constructor(args: { cassetteName: string; message: string }) {
    super(
      `Cassette "${args.cassetteName}" failed schema validation: ${args.message}`,
    );
    this.name = "CassetteFormatError";
    this.cassetteName = args.cassetteName;
  }
}

/**
 * Thrown when `replay` mode encounters more than one unmatched request. Carries
 * the full list so the caller can diagnose all missing entries in one pass rather
 * than fixing misses one at a time. When only a single request is missed,
 * `CassetteMissError` is thrown directly for backward compatibility.
 */
export class AggregateCassetteMissError extends Error {
  readonly misses: CassetteMissError[];

  constructor(misses: CassetteMissError[]) {
    const summary = misses
      .map((m) => `  • ${m.matchKey} (cassette "${m.cassetteName}")`)
      .join("\n");
    super(
      `${misses.length} cassette misses:\n${summary}\nRe-run with mode='record' to capture these interactions.`,
    );
    this.name = "AggregateCassetteMissError";
    this.misses = misses;
  }
}

/**
 * Thrown in `record` mode when `strict: true` is set in the redaction config
 * and one or more configured redaction rules matched zero occurrences across
 * the cassette's entries. Almost always indicates a typo in a path or pattern.
 */
export class CassetteRedactionError extends Error {
  readonly cassetteName: string;
  readonly unmatchedPatterns: string[];

  constructor(args: { cassetteName: string; unmatchedPatterns: string[] }) {
    const list = args.unmatchedPatterns.join(", ");
    super(
      `Strict redaction check failed for cassette "${args.cassetteName}": ` +
        `the following configured rules matched nothing — likely a typo: ${list}`,
    );
    this.name = "CassetteRedactionError";
    this.cassetteName = args.cassetteName;
    this.unmatchedPatterns = args.unmatchedPatterns;
  }
}
