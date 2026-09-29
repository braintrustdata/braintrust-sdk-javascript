type PreprocessorResult =
  | string
  | number
  | boolean
  | null
  | readonly PreprocessorResult[]
  | { readonly [key: string]: PreprocessorResult };

/**
 * @experimental This API is not yet stabilized and may change across non-major versions.
 */
export type PreprocessorSpanData<
  TInput = unknown,
  TOutput = unknown,
  TMetadata = unknown,
> = {
  id: string;
  root_span_id: string;
  input?: TInput;
  output?: TOutput;
  error?: unknown;
  metadata?: TMetadata;
  span_attributes?: {
    type?: string | null;
    name?: string | null;
    [key: string]: unknown;
  } | null;
};

/**
 * @experimental This API is not yet stabilized and may change across non-major versions.
 */
export type PreprocessorHandler<
  TInput = unknown,
  TOutput = unknown,
  TMetadata = unknown,
  TResult extends PreprocessorResult = PreprocessorResult,
> = (span: PreprocessorSpanData<TInput, TOutput, TMetadata>) => TResult;

type CustomPreprocessorDefinition = {
  name: string;
  slug: string;
  project?: string | { id: string } | { name: string };
};

/**
 * @experimental This API is not yet stabilized and may change across non-major versions.
 */
export type CustomPreprocessor<
  TInput = unknown,
  TOutput = unknown,
  TMetadata = unknown,
  TResult extends PreprocessorResult = PreprocessorResult,
> = CustomPreprocessorDefinition & {
  kind: "preprocessor";
  handler: PreprocessorHandler<TInput, TOutput, TMetadata, TResult>;
};

/**
 * Defines a custom preprocessor without executing or uploading it.
 * Export the returned definition from your module for discovery by tooling.
 *
 * The handler receives one span at a time and must return a synchronous,
 * JSON-serializable value, or null to skip that span.
 * It runs in QuickJS (ES2023); Node.js APIs, network access, and unbundled
 * imports are unavailable in the deployed handler.
 *
 * @example
 * ```ts
 * import { customPreprocessor } from "braintrust/preprocessors";
 *
 * export const conversation = customPreprocessor(
 *   { name: "Conversation", slug: "conversation", project: "My project" },
 *   (span) => {
 *     if (span.span_attributes?.type === "score") return null;
 *     return typeof span.output === "string" ? span.output : null;
 *   },
 * );
 * ```
 *
 * @experimental This API is not yet stabilized and may change across non-major versions.
 */
export function customPreprocessor<
  TInput = unknown,
  TOutput = unknown,
  TMetadata = unknown,
  TResult extends PreprocessorResult = PreprocessorResult,
>(
  definition: CustomPreprocessorDefinition,
  handler: PreprocessorHandler<TInput, TOutput, TMetadata, TResult>,
): CustomPreprocessor<TInput, TOutput, TMetadata, TResult> {
  return { ...definition, handler, kind: "preprocessor" };
}
