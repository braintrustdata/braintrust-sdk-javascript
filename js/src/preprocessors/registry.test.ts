import { expect, expectTypeOf, test, vi } from "vitest";
import {
  customPreprocessor,
  type CustomPreprocessor,
  type PreprocessorHandler,
  type PreprocessorSpanData,
} from "./exports";

test("contextually types span fields and infers structured results", () => {
  const preprocessor = customPreprocessor(
    { name: "Conversation", slug: "conversation" },
    (span) => {
      expectTypeOf(span).toEqualTypeOf<PreprocessorSpanData>();
      expectTypeOf(span.input).toBeUnknown();
      expectTypeOf(span.output).toBeUnknown();
      expectTypeOf(span.metadata).toBeUnknown();
      expectTypeOf(span.error).toBeUnknown();
      expectTypeOf(span.span_attributes?.name).toEqualTypeOf<
        string | null | undefined
      >();
      expectTypeOf(span.span_attributes?.custom).toBeUnknown();
      if (span.span_attributes?.type === "score") return null;
      return [{ role: "assistant", content: String(span.output) }];
    },
  );

  expectTypeOf(preprocessor.kind).toEqualTypeOf<"preprocessor">();
  expectTypeOf(preprocessor.handler).returns.toEqualTypeOf<
    { role: string; content: string }[] | null
  >();
  const span: PreprocessorSpanData = {
    id: "row",
    root_span_id: "root",
    output: "Hello",
    span_attributes: { type: null, name: null, custom: 42 },
  };
  expect(preprocessor.handler(span)).toEqual([
    { role: "assistant", content: "Hello" },
  ]);
  expect(
    preprocessor.handler({ ...span, span_attributes: { type: "score" } }),
  ).toBeNull();
  expect(preprocessor.handler({ ...span, span_attributes: null })).toEqual([
    { role: "assistant", content: "Hello" },
  ]);
});

test("supports explicit span generics and standalone typed handlers", () => {
  const handler: PreprocessorHandler<
    { prompt: string },
    string,
    { source: string },
    string | null
  > = (span) => {
    expectTypeOf(span.input).toEqualTypeOf<{ prompt: string } | undefined>();
    expectTypeOf(span.output).toEqualTypeOf<string | undefined>();
    expectTypeOf(span.metadata).toEqualTypeOf<{ source: string } | undefined>();
    return span.output ?? null;
  };
  const definition = { name: "Text", slug: "text", project: { id: "project" } };
  const preprocessor = customPreprocessor(definition, handler);
  expectTypeOf(preprocessor).toEqualTypeOf<
    CustomPreprocessor<
      { prompt: string },
      string,
      { source: string },
      string | null
    >
  >();
  expect(preprocessor.handler({ id: "row", root_span_id: "root" })).toBeNull();

  customPreprocessor<string, number, { source: string }>(definition, (span) => {
    expectTypeOf(span.input).toEqualTypeOf<string | undefined>();
    expectTypeOf(span.output).toEqualTypeOf<number | undefined>();
    expectTypeOf(span.metadata).toEqualTypeOf<{ source: string } | undefined>();
    return span.output;
  });
});

test.each([undefined, "project", { id: "project-id" }, { name: "Project" }])(
  "retains the handler without invoking it for project %j",
  (project) => {
    const definition = Object.freeze({ name: "Text", slug: "text", project });
    const handler = vi.fn(() => "text");
    const preprocessor = customPreprocessor(definition, handler);

    expect(handler).not.toHaveBeenCalled();
    expect(preprocessor.handler).toBe(handler);
    expect(preprocessor.project).toBe(project);
    expect(preprocessor).not.toBe(definition);
  },
);

test("requires definition identifiers and the per-span handler contract", () => {
  // @ts-expect-error The slug is required for discovery.
  customPreprocessor({ name: "Text" }, () => null);
  // @ts-expect-error A display name is required.
  customPreprocessor({ slug: "text" }, () => null);
  customPreprocessor(
    // @ts-expect-error Project references use a string, id, or name.
    { name: "Text", slug: "text", project: { slug: "project" } },
    () => null,
  );
  customPreprocessor(
    { name: "Text", slug: "text" },
    // @ts-expect-error The handler receives a span, not a string.
    (span: string) => span,
  );
  customPreprocessor(
    { name: "Text", slug: "text" },
    // @ts-expect-error Custom preprocessors do not receive a config argument.
    (_span: PreprocessorSpanData, config: Record<string, unknown>) => config,
  );
});
