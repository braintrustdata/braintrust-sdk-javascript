/**
 * seinfeld — Generic VCR/cassette library for Node.js, built on MSW.
 *
 * See README.md for an overview. The two-pipeline filtering model is the
 * key concept: normalizers transform requests for matching only, while
 * redactors transform what gets persisted to disk.
 */

// Core data types
export type {
  BodyPayload,
  CassetteEntry,
  CassetteFile,
  CassetteMode,
  NormalizedRequest,
  RecordedRequest,
  RecordedResponse,
} from "./cassette";

// Errors
export {
  AggregateCassetteMissError,
  CassetteFormatError,
  CassetteMissError,
  CassetteRedactionError,
  CassetteVersionError,
} from "./errors";

// Storage
export type { CassetteStore, JsonFileStoreOptions } from "./store";
export { createJsonFileStore, createMemoryStore } from "./store";

// Filters / normalization (matching pipeline)
export type { FilterConfig, FilterPreset, FilterSpec } from "./normalizer";

// Redaction (persistence pipeline)
export type {
  RedactionConfig,
  RedactionPreset,
  RedactionSpec,
} from "./redactor";
export { apiKeyHeader, bearerToken, cookies } from "./redactor/presets";

// Matching
export type { MatchCandidate, Matcher } from "./matcher";
export { createDefaultMatcher } from "./matcher";

// Recorder — the main entry point
export type { Cassette, CassetteOptions } from "./recorder";
export { createCassette } from "./recorder";
