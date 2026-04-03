/**
 * The result returned by a classifier function. Unlike `Score`, `id` is
 * required and the span will be recorded as a classifier span.
 */
export interface Classification {
  name: string;
  id: string;
  label?: string;
  metadata?: Record<string, unknown>;
}

/**
 * The serialized form of a classification stored in the `classifications` log record.
 */
export interface ClassificationItem {
  id: string;
  label: string;
  metadata?: Record<string, unknown>;
}

export interface Score {
  name: string;
  score: number | null;
  metadata?: Record<string, unknown>;
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
