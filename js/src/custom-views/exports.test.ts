import { describe, expect, expectTypeOf, test } from "vitest";
import * as customViewsExports from "./exports";
import { customDatasetView, customTraceView } from "./exports";

describe("custom views", () => {
  test("only exposes the public custom view helpers", () => {
    expect(Object.keys(customViewsExports).sort()).toEqual([
      "customDatasetView",
      "customTraceView",
    ]);
  });

  test("creates trace custom view definitions", () => {
    const component = (props: { span: { span_id: string } }) =>
      props.span.span_id;

    const returned = customTraceView(
      {
        name: "Trace Summary",
        slug: "trace-summary",
        project: { name: "my-project" },
      },
      component,
    );

    expect(returned).toEqual({
      kind: "trace",
      name: "Trace Summary",
      slug: "trace-summary",
      project: { name: "my-project" },
      component,
    });
  });

  test("creates dataset custom view definitions", () => {
    const component = (props: { id: string }) => props.id;

    const returned = customDatasetView(
      {
        name: "Dataset Row",
        slug: "dataset-row",
        dataset: { id: "dataset-id" },
        project: "my-project",
      },
      component,
    );

    expect(returned).toEqual({
      kind: "dataset",
      name: "Dataset Row",
      slug: "dataset-row",
      dataset: { id: "dataset-id" },
      project: "my-project",
      component,
    });
  });

  test("allows default-export-friendly view values", () => {
    const first = () => "first";
    const second = () => "second";

    const traceView = customTraceView(
      {
        name: "First",
        slug: "shared",
      },
      first,
    );
    const datasetView = customDatasetView(
      {
        name: "Second",
        slug: "shared",
        dataset: { name: "rows" },
      },
      second,
    );

    const defaultTraceExport = traceView;
    const defaultDatasetExport = datasetView;
    expect(defaultTraceExport.component).toBe(first);
    expect(defaultDatasetExport.component).toBe(second);
  });

  test("preserves trace view generic prop types", () => {
    type Input = { prompt: string };
    type Output = { answer: string };
    type Expected = { answer: string };
    type Metadata = { topic: string };

    const returned = customTraceView<Input, Output, Expected, Metadata>(
      {
        name: "Typed Trace",
        slug: "typed-trace",
      },
      (props) => {
        expectTypeOf(props.span.data.input).toEqualTypeOf<Input | undefined>();
        expectTypeOf(props.span.data.output).toEqualTypeOf<
          Output | undefined
        >();
        expectTypeOf(props.span.data.expected).toEqualTypeOf<
          Expected | undefined
        >();
        expectTypeOf(props.span.data.metadata).toEqualTypeOf<
          Metadata | undefined
        >();
        expectTypeOf(props.trace.spans["span-id"].data.metadata).toEqualTypeOf<
          Metadata | undefined
        >();
        expectTypeOf(props.trace.update).parameter(0).toEqualTypeOf<{
          target?: "selected" | "root" | { spanId: string };
          metadata?: Partial<Metadata> & Record<string, unknown>;
          tags?: string[] | null;
        }>();
        return null;
      },
    );

    expectTypeOf(returned.kind).toEqualTypeOf<"trace">();
    expect(returned.kind).toBe("trace");
  });

  test("preserves dataset view generic prop types", () => {
    type Input = { prompt: string };
    type Expected = { answer: string };
    type Metadata = { difficulty: number };

    const returned = customDatasetView<Input, Expected, Metadata>(
      {
        name: "Typed Dataset",
        slug: "typed-dataset",
        dataset: { name: "rows" },
      },
      (props) => {
        expectTypeOf(props.input).toEqualTypeOf<Input | undefined>();
        expectTypeOf(props.expected).toEqualTypeOf<Expected | undefined>();
        expectTypeOf(props.metadata).toEqualTypeOf<Metadata | undefined>();
        expectTypeOf(props.tags).toEqualTypeOf<string[] | undefined>();
        return null;
      },
    );

    expectTypeOf(returned.kind).toEqualTypeOf<"dataset">();
    expect(returned.kind).toBe("dataset");
  });
});
