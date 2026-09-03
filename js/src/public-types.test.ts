import { expect, expectTypeOf, test } from "vitest";

import * as publicExports from "./exports";
import type {
  ContextManager,
  ContextParentSpanIds,
  CurrentSpanStore,
  Dataset,
  DurableEvalStore,
  EvalScorer,
  EvalTask,
  LangChainCallbackHandlerOptions,
  PropagationContext,
  Span,
  StartSpanArgs,
  TemplateRendererPlugin,
  Trace,
} from "./exports";
import {
  BraintrustLangChainCallbackHandler,
  init,
  initDataset,
  withParent,
} from "./exports";

test("exports only intentional extension types", () => {
  expectTypeOf<Span>().toBeObject();
  expectTypeOf<StartSpanArgs>().toBeObject();
  expectTypeOf<ContextManager>().toBeObject();
  expectTypeOf<ContextParentSpanIds>().toBeObject();
  expectTypeOf<CurrentSpanStore>().toBeObject();
  expectTypeOf<PropagationContext>().toBeObject();
  expectTypeOf(publicExports.configureContextManager).toBeFunction();
  expectTypeOf<Trace>().toBeObject();
  expectTypeOf<DurableEvalStore>().toBeObject();
  expectTypeOf<TemplateRendererPlugin>().toBeObject();
  expectTypeOf<LangChainCallbackHandlerOptions>().toBeObject();
  expectTypeOf(BraintrustLangChainCallbackHandler).toBeConstructibleWith();
  expectTypeOf<
    EvalTask<unknown, unknown, unknown, void, never>
  >().toBeFunction();
  expectTypeOf<EvalScorer<unknown, unknown, unknown>>().toBeFunction();
});

test("does not expose runtime schemas or implementation helpers", () => {
  for (const name of [
    "AttachmentReference",
    "braintrustStreamChunkSchema",
    "logs3OverflowUploadSchema",
    "promptContentsSchema",
    "promptDefinitionSchema",
    "promptDefinitionWithToolsSchema",
    "SpanImpl",
    "IDGenerator",
    "_exportsForTestingOnly",
    "default",
  ]) {
    expect(publicExports).not.toHaveProperty(name);
  }
});

test("accepts only canonical v4 call shapes", () => {
  if (false) {
    init({ project: "project" });
    initDataset({ project: "project", dataset: "dataset" });

    // @ts-expect-error The string-first overload was removed in v4.
    init("project");
    // @ts-expect-error The string-first overload was removed in v4.
    initDataset("project", { dataset: "dataset" });
    // @ts-expect-error Exported span slugs are internal integration plumbing.
    withParent("exported-span", () => undefined);

    const dataset = null as unknown as Dataset;
    // @ts-expect-error Dataset records use `expected`, not the legacy `output` alias.
    dataset.insert({ input: "input", output: "expected" });

    const span = null as unknown as Span;
    // @ts-expect-error Spans end with `end()`; the `close()` alias was removed.
    span.close();
  }

  expect(true).toBe(true);
});
