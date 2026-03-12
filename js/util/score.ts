/**
 * A classification result: either a plain string label, or an object with a
 * stable `id` and an optional human-readable `label` (defaults to `id`).
 * When set, the value is recorded in the `classifications` column keyed by
 * scorer name instead of (or in addition to) `score`.
 */
export type Classification = string | { id: string; label?: string };

export interface Score {
  name: string;
  score: number | null;
  metadata?: Record<string, unknown>;
  classification?: Classification;
  // DEPRECATION_NOTICE: this field is deprecated, as errors are propagated up to the caller.
  /**
   * @deprecated
   */
  error?: unknown;
}

export type ScorerArgs<Output, Extra> = {
  output: Output;
  expected?: Output;
} & Extra;

export type Scorer<Output, Extra> = (
  args: ScorerArgs<Output, Extra>,
) => Score | Promise<Score>;
