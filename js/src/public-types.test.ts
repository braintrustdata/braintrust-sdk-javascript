import { expectTypeOf, test } from "vitest";
import { z } from "zod/v3";

import {
  AttachmentReference,
  braintrustStreamChunkSchema,
  logs3OverflowUploadSchema,
  promptContentsSchema,
  promptDefinitionSchema,
  promptDefinitionWithToolsSchema,
  type BraintrustStreamChunk,
  type EvalParameters,
  type Logs3OverflowUpload,
  type PromptContents,
  type PromptDefinition,
  type PromptDefinitionWithTools,
} from "./exports";
import type { InferParameters } from "./eval-parameters";
import type { AttachmentReferenceType } from "./generated_plain_types";
import type { Prompt } from "./logger";
import {
  spanComponentsV3Schema,
  type SpanComponentsV3Data,
} from "../util/span_identifier_v3";
import {
  spanComponentsV4Schema,
  type SpanComponentsV4Data,
} from "../util/span_identifier_v4";

test("exported validators preserve their public output types", () => {
  expectTypeOf<
    z.infer<typeof AttachmentReference>
  >().toEqualTypeOf<AttachmentReferenceType>();
  expectTypeOf<
    z.infer<typeof braintrustStreamChunkSchema>
  >().toEqualTypeOf<BraintrustStreamChunk>();
  expectTypeOf<
    z.infer<typeof logs3OverflowUploadSchema>
  >().toEqualTypeOf<Logs3OverflowUpload>();
  expectTypeOf<
    z.infer<typeof promptContentsSchema>
  >().toEqualTypeOf<PromptContents>();
  expectTypeOf<
    z.infer<typeof promptDefinitionSchema>
  >().toEqualTypeOf<PromptDefinition>();
  expectTypeOf<
    z.infer<typeof promptDefinitionWithToolsSchema>
  >().toEqualTypeOf<PromptDefinitionWithTools>();
  expectTypeOf<
    z.infer<typeof spanComponentsV3Schema>
  >().toEqualTypeOf<SpanComponentsV3Data>();
  expectTypeOf<
    z.infer<typeof spanComponentsV4Schema>
  >().toEqualTypeOf<SpanComponentsV4Data>();
});

test("evaluation parameters retain custom schema inference", () => {
  const parameters = {
    subject: z.string(),
    model: { type: "model" as const },
    prompt: { type: "prompt" as const },
  } satisfies EvalParameters;

  expectTypeOf<InferParameters<typeof parameters>>().toEqualTypeOf<{
    subject: string;
    model: string;
    prompt: Prompt;
  }>();
});
