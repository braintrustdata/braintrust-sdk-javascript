import { z } from "zod/v3";
import {
  ToolFunctionDefinition as toolFunctionDefinitionSchema,
  type ToolFunctionDefinitionType as ToolFunctionDefinition,
  ChatCompletionMessageParam as chatCompletionMessageParamSchema,
  ModelParams as modelParamsSchema,
  type PromptBlockDataType as PromptBlockData,
  type PromptDataType as PromptData,
} from "./generated_types";

// This roughly maps to promptBlockDataSchema, but is more ergonomic for the user.
export const promptContentsSchema = z.union([
  z.object({
    prompt: z.string(),
  }),
  z.object({
    messages: z.array(chatCompletionMessageParamSchema),
  }),
]);

export type PromptContents = z.infer<typeof promptContentsSchema>;

export const promptDefinitionSchema = promptContentsSchema.and(
  z.object({
    model: z.string(),
    params: modelParamsSchema.optional(),
    templateFormat: z.enum(["mustache", "nunjucks", "none"]).optional(),
    environments: z.array(z.string()).optional(),
  }),
);

export type PromptDefinition = z.infer<typeof promptDefinitionSchema>;

export const promptDefinitionWithToolsSchema = promptDefinitionSchema.and(
  z.object({
    tools: z.array(toolFunctionDefinitionSchema).optional(),
  }),
);

export type PromptDefinitionWithTools = z.infer<
  typeof promptDefinitionWithToolsSchema
>;

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
