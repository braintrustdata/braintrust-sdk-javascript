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
