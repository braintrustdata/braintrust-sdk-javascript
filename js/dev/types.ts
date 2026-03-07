import {
  FunctionId as functionIdSchema,
  InvokeParent as invokeParentSchema,
  RunEval as runEvalSchema,
  PromptData as promptDataSchema,
} from "../src/generated_types";
import { z } from "zod/v3";
import { EvaluatorDef } from "../src/framework";
import { BaseMetadata } from "../src/logger";

export const evalBodySchema = z.object({
  name: z.string(),
  parameters: z.record(z.string(), z.unknown()).nullish(),
  data: runEvalSchema.shape.data,
  scores: z
    .array(
      z.object({
        function_id: functionIdSchema,
        name: z.string(),
      }),
    )
    .nullish(),
  experiment_name: z.string().nullish(),
  project_id: z.string().nullish(),
  parent: invokeParentSchema.optional(),
  stream: z.boolean().optional(),
});

export type EvaluatorManifest = Record<
  string,
  EvaluatorDef<unknown, unknown, unknown, BaseMetadata>
>;

export const staticParametersSchema = z.record(
  z.string(),
  z.union([
    z.object({
      type: z.literal("prompt"),
      default: promptDataSchema.optional(),
      description: z.string().optional(),
    }),
    z.object({
      type: z.literal("model"),
      default: z.string().optional(),
      description: z.string().optional(),
    }),
    z.object({
      type: z.literal("data"),
      schema: z.record(z.unknown()),
      default: z.unknown().optional(),
      description: z.string().optional(),
    }),
  ]),
);

export type StaticParametersSchema = z.infer<typeof staticParametersSchema>;

const evalParametersSerializedSchema = staticParametersSchema;
export type EvalParameterSerializedSchema = z.infer<
  typeof evalParametersSerializedSchema
>;

export const parametersSchema = z.object({
  type: z.literal("object"),
  properties: z.record(z.string(), z.record(z.unknown())),
  required: z.array(z.string()).optional(),
  additionalProperties: z.boolean().optional(),
});

export type ParametersSchema = z.infer<typeof parametersSchema>;

const parametersSourceSchema = z.object({
  parametersId: z.string().optional(),
  slug: z.string(),
  name: z.string(),
  projectId: z.string().optional(),
  version: z.string().optional(),
});

export type ParametersSource = z.infer<typeof parametersSourceSchema>;

const parametersContainerSchema = z.object({
  type: z.literal("braintrust.parameters"),
  schema: parametersSchema,
  source: parametersSourceSchema,
});

export type ParametersContainer = z.infer<typeof parametersContainerSchema>;

const staticParametersContainerSchema = z.object({
  type: z.literal("braintrust.staticParameters"),
  schema: staticParametersSchema,
  source: z.null(),
});

export type StaticParametersContainer = z.infer<
  typeof staticParametersContainerSchema
>;

export const serializedParametersContainerSchema = z.union([
  parametersContainerSchema,
  staticParametersContainerSchema,
  // keeping this type here since old versions of the SDK will still pass the unwrapped schema and we need to handle this in the app
  staticParametersSchema,
]);

export type SerializedParametersContainer = z.infer<
  typeof serializedParametersContainerSchema
>;

export const evaluatorDefinitionSchema = z.object({
  parameters: serializedParametersContainerSchema.optional(),
  scores: z.array(z.object({ name: z.string() })).optional(),
});
export type EvaluatorDefinition = z.infer<typeof evaluatorDefinitionSchema>;

export const evaluatorDefinitionsSchema = z.record(
  z.string(),
  evaluatorDefinitionSchema,
);

export type EvaluatorDefinitions = z.infer<typeof evaluatorDefinitionsSchema>;
