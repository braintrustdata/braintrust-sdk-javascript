import { z } from "zod/v3";
import {
  ToolFunctionDefinition as toolFunctionDefinitionSchema,
  ChatCompletionMessageParam as chatCompletionMessageParamSchema,
  ModelParams as modelParamsSchema,
} from "./generated_types";
import type {
  ToolFunctionDefinitionType as ToolFunctionDefinition,
  ChatCompletionMessageParamType,
  ModelParamsType,
  PromptBlockDataType as PromptBlockData,
  PromptDataType as PromptData,
} from "./generated_plain_types";

// This roughly maps to promptBlockDataSchema, but is more ergonomic for the user.
export type PromptContents =
  | { prompt: string }
  | { messages: ChatCompletionMessageParamType[] };

const internalPromptContentsSchema = z.union([
  z.object({
    prompt: z.string(),
  }),
  z.object({
    messages: z.array(chatCompletionMessageParamSchema),
  }),
]);
export const promptContentsSchema: z.ZodType<
  PromptContents,
  z.ZodTypeDef,
  unknown
> = internalPromptContentsSchema;

export type PromptDefinition = PromptContents & {
  model: string;
  params?: ModelParamsType;
  templateFormat?: "mustache" | "nunjucks" | "none";
  environments?: string[];
};

const internalPromptDefinitionSchema = internalPromptContentsSchema.and(
  z.object({
    model: z.string(),
    params: modelParamsSchema.optional(),
    templateFormat: z.enum(["mustache", "nunjucks", "none"]).optional(),
    environments: z.array(z.string()).optional(),
  }),
);
export const promptDefinitionSchema: z.ZodType<
  PromptDefinition,
  z.ZodTypeDef,
  unknown
> = internalPromptDefinitionSchema;

export type PromptDefinitionWithTools = PromptDefinition & {
  tools?: ToolFunctionDefinition[];
};

const internalPromptDefinitionWithToolsSchema =
  internalPromptDefinitionSchema.and(
    z.object({
      tools: z.array(toolFunctionDefinitionSchema).optional(),
    }),
  );
export const promptDefinitionWithToolsSchema: z.ZodType<
  PromptDefinitionWithTools,
  z.ZodTypeDef,
  unknown
> = internalPromptDefinitionWithToolsSchema;

export function promptDefinitionToPromptData(
  promptDefinition: PromptDefinition,
  rawTools?: ToolFunctionDefinition[],
): PromptData {
  const promptBlock: PromptBlockData =
    "messages" in promptDefinition
      ? {
          type: "chat",
          messages: promptDefinition.messages,
          tools:
            rawTools && rawTools.length > 0
              ? JSON.stringify(rawTools)
              : undefined,
        }
      : {
          type: "completion",
          content: promptDefinition.prompt,
        };

  return {
    prompt: promptBlock,
    options: {
      model: promptDefinition.model,
      params: promptDefinition.params,
    },
    ...(promptDefinition.templateFormat
      ? { template_format: promptDefinition.templateFormat }
      : {}),
  };
}
