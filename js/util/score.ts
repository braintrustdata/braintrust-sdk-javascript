/**
 * The result returned by a classifier function. Unlike `Score`, `id` is
 * required and the span will be recorded as a classifier span.
 */
export interface Classification {
  /**
   * The name of this classification result. Used as the key in the
   * `classifications` log record. If omitted, defaults to the classifier
   * function's name.
   */
  name: string;
  /**
   * A machine-readable identifier for the classification outcome
   * (e.g. `"positive"`, `"negative"`, `"neutral"`). This value is stored
   * in the log and used for programmatic analysis.
   */
  id: string;
  /**
   * An optional human-readable display label for this outcome. If omitted,
   * defaults to `id`. Use this when you want a friendlier label in the UI
   * while keeping a stable `id` for programmatic use.
   */
  label?: string;
  /**
   * Optional arbitrary metadata to attach to this classification result.
   */
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
