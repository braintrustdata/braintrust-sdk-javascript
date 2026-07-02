type SpanFieldName = "input" | "output" | "expected" | "metadata";

type SpanFields<
  TInput = unknown,
  TOutput = unknown,
  TExpected = unknown,
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
> = {
  input?: TInput;
  output?: TOutput;
  expected?: TExpected;
  metadata?: TMetadata;
};

type TraceViewSpan<
  TInput = unknown,
  TOutput = unknown,
  TExpected = unknown,
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
> = {
  id: string;
  span_id: string;
  root_span_id: string;
  parent_span_id?: string | null;
  span_parents?: string[];
  data: {
    input?: TInput;
    output?: TOutput;
    expected?: TExpected;
    metadata?: TMetadata;
    scores?: Record<string, number>;
    metrics?: Record<string, number | string>;
    error?: string;
    tags?: string[];
    span_attributes?: Record<string, unknown>;
    [key: string]: unknown;
  };
  children: string[];
};

type CustomViewUpdateTarget = "selected" | "root" | { spanId: string };

type CustomViewUpdateResult = {
  transactionId: string | null;
};

type CustomViewSpanUpdate<
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
> = {
  target?: CustomViewUpdateTarget;
  metadata?: Partial<TMetadata> & Record<string, unknown>;
  tags?: string[] | null;
};

type TraceViewTrace<
  TInput = unknown,
  TOutput = unknown,
  TExpected = unknown,
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
> = {
  rootSpanId: string;
  selectedSpanId: string;
  spanOrder: string[];
  spans: Record<string, TraceViewSpan<TInput, TOutput, TExpected, TMetadata>>;
  fetchSpanFields: (
    spanIds: string | string[],
    fields?: SpanFieldName[],
  ) => Promise<
    Record<string, SpanFields<TInput, TOutput, TExpected, TMetadata>>
  >;
  update: (
    update: CustomViewSpanUpdate<TMetadata>,
  ) => Promise<CustomViewUpdateResult>;
};

type TraceViewUpdate<
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
> = {
  (field: string, value: unknown): void;
  (patch: Partial<{ metadata: TMetadata; tags: string[] | null }>): void;
};

type TraceViewProps<
  TInput = unknown,
  TOutput = unknown,
  TExpected = unknown,
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
> = {
  trace: TraceViewTrace<TInput, TOutput, TExpected, TMetadata>;
  span: TraceViewSpan<TInput, TOutput, TExpected, TMetadata>;
  selectSpan?: (spanId: string) => void;
  update?: TraceViewUpdate<TMetadata>;
};

type DatasetViewProps<
  TInput = unknown,
  TExpected = unknown,
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
> = {
  id: string;
  input?: TInput;
  expected?: TExpected;
  metadata?: TMetadata;
  tags?: string[];
};

type Component<Props> = (props: Props) => unknown;

type ProjectRef = string | { id: string } | { name: string };
type DatasetRef = { id: string } | { name: string };

type CustomTraceViewDefinition = {
  name: string;
  slug: string;
  project?: ProjectRef;
};

type CustomTraceView<
  TInput = unknown,
  TOutput = unknown,
  TExpected = unknown,
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
> = CustomTraceViewDefinition & {
  kind: "trace";
  component: Component<TraceViewProps<TInput, TOutput, TExpected, TMetadata>>;
};

type CustomDatasetViewDefinition = {
  name: string;
  slug: string;
  dataset: DatasetRef;
  project?: ProjectRef;
};

type CustomDatasetView<
  TInput = unknown,
  TExpected = unknown,
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
> = CustomDatasetViewDefinition & {
  kind: "dataset";
  component: Component<DatasetViewProps<TInput, TExpected, TMetadata>>;
};

/**
 * Defines a trace custom view for discovery by the `bt views` CLI.
 *
 * @experimental This API is not yet stabilized and may change across non-major versions.
 */
export function customTraceView<
  TInput = unknown,
  TOutput = unknown,
  TExpected = unknown,
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
>(
  definition: CustomTraceViewDefinition,
  component: Component<TraceViewProps<TInput, TOutput, TExpected, TMetadata>>,
): CustomTraceView<TInput, TOutput, TExpected, TMetadata> {
  return { ...definition, component, kind: "trace" };
}

/**
 * Defines a dataset custom view for discovery by the `bt views` CLI.
 *
 * @experimental This API is not yet stabilized and may change across non-major versions.
 */
export function customDatasetView<
  TInput = unknown,
  TExpected = unknown,
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
>(
  definition: CustomDatasetViewDefinition,
  component: Component<DatasetViewProps<TInput, TExpected, TMetadata>>,
): CustomDatasetView<TInput, TExpected, TMetadata> {
  return { ...definition, component, kind: "dataset" };
}
