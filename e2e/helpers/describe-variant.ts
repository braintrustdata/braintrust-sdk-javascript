import { describe } from "vitest";

const cassetteMode = process.env.BRAINTRUST_E2E_CASSETTE_MODE;
const isRecordingMode =
  cassetteMode === "record" || cassetteMode === "record-missing";

/**
 * Describe block for one version variant inside `describe.concurrent(...)`.
 *
 * During replay the block inherits the parent's concurrency, so variants and
 * their wrapped/auto-hook suites run in parallel. `describe.sequential` here
 * would serialize every variant in the file. Recording stays sequential because
 * suites in the same variant can write to one shared cassette.
 *
 * Concurrent tests must use the test-context `expect` for file snapshots, e.g.
 * `matchSpanTreeSnapshot(events, path, { snapshotExpect: expect })`.
 */
export const describeVariant = isRecordingMode ? describe.sequential : describe;
