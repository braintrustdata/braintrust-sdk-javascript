import type {
  Attributes,
  Context,
  HrTime,
  Link,
  Span,
  SpanContext,
  SpanKind,
  SpanStatus,
} from "@opentelemetry/api";

// Structural contracts for the data this integration uses. They intentionally
// do not import SDK types: the application selects its SDK and exporter version.
interface InstrumentationScope {
  name: string;
  version?: string;
  schemaUrl?: string;
  attributes?: Attributes;
}

export interface ReadableSpan {
  readonly name: string;
  readonly kind: SpanKind;
  readonly attributes: Attributes;
  readonly status: SpanStatus;
  readonly startTime: HrTime;
  readonly endTime: HrTime;
  readonly duration: HrTime;
  readonly events: readonly {
    name: string;
    time: HrTime;
    attributes?: Attributes;
    droppedAttributesCount?: number;
  }[];
  readonly links: readonly Link[];
  readonly resource: {
    readonly attributes: Attributes;
    readonly schemaUrl?: string;
    readonly asyncAttributesPending?: boolean;
    waitForAsyncAttributes?(): Promise<void>;
  };
  readonly parentSpanId?: string;
  readonly parentSpanContext?: SpanContext;
  readonly instrumentationScope?: InstrumentationScope;
  readonly instrumentationLibrary?: InstrumentationScope;
  readonly droppedAttributesCount: number;
  readonly droppedEventsCount: number;
  readonly droppedLinksCount: number;
  spanContext(): SpanContext;
}

export interface ExportResult {
  code: number;
  error?: Error;
}

export interface SpanExporter<S extends ReadableSpan> {
  export(spans: S[], callback: (result: ExportResult) => void): void;
  shutdown(): Promise<void>;
  forceFlush?(): Promise<void>;
}

export interface SpanProcessor<S extends ReadableSpan = ReadableSpan> {
  onStart(span: Span, parentContext: Context): void;
  onEnding?(span: Span): void;
  onEnd(span: S): void;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}
