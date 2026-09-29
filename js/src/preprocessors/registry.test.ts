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
    return span.output ?? null;
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

test("infers nested serializable results, including readonly values", () => {
  const result = {
    messages: [{ role: "assistant", content: "Hello" }],
    count: 1,
    complete: true,
    error: null,
  } as const;
  const preprocessor = customPreprocessor(
    { name: "Conversation", slug: "conversation" },
    () => result,
  );

  expectTypeOf(preprocessor.handler).returns.toEqualTypeOf<typeof result>();
  expect(preprocessor.handler({ id: "row", root_span_id: "root" })).toBe(
    result,
  );
});

test("rejects asynchronous and nonserializable results", () => {
  const definition = { name: "Text", slug: "text" };

  // @ts-expect-error Preprocessors must return synchronously.
  customPreprocessor(definition, async () => "text");
  // @ts-expect-error Functions cannot be serialized as results.
  customPreprocessor(definition, () => () => "text");
  // @ts-expect-error Symbols cannot be serialized as results.
  customPreprocessor(definition, () => Symbol("text"));
  // @ts-expect-error Bigints cannot be serialized as JSON.
  customPreprocessor(definition, () => 1n);
  // @ts-expect-error Use null to skip a span instead of undefined.
  customPreprocessor(definition, () => undefined);
  // @ts-expect-error Nested object values must also be serializable.
  customPreprocessor(definition, () => ({ value: Promise.resolve("text") }));
  // @ts-expect-error Array elements must also be serializable.
  customPreprocessor(definition, () => [Symbol("text")]);
  // @ts-expect-error Explicit result generics cannot allow promises.
  customPreprocessor<unknown, unknown, unknown, Promise<string>>(
    definition,
    async () => "text",
  );

  // @ts-expect-error Standalone handlers must also return synchronously.
  const handler: PreprocessorHandler = async () => "text";
  expectTypeOf(handler).toBeFunction();
  expectTypeOf<
    // @ts-expect-error Explicit handler result types cannot allow promises.
    PreprocessorHandler<unknown, unknown, unknown, Promise<string>>
  >();
  expectTypeOf<
    // @ts-expect-error Explicit definition result types cannot allow promises.
    CustomPreprocessor<unknown, unknown, unknown, Promise<string>>
  >();
});
