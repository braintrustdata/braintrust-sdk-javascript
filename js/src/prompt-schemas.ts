import { z } from "zod/v3";
import {
  ToolFunctionDefinition as toolFunctionDefinitionSchema,
  type ToolFunctionDefinitionType as ToolFunctionDefinition,
  ChatCompletionMessageParam as chatCompletionMessageParamSchema,
  ModelParams as modelParamsSchema,
  ChatCompletionContentPartText as chatCompletionContentPartTextSchema,
  PromptBlockData as generatedPromptBlockDataSchema,
  PromptData as generatedPromptDataSchema,
} from "./generated_types";

const decisionPromptSchema = z.object({
  type: z.literal("decisions"),
  input: z.union([
    z.string(),
    z.array(
      z.object({
        role: z.enum(["system", "developer", "user", "assistant"]),
        content: z.union([
          z.string(),
          z.array(chatCompletionContentPartTextSchema),
        ]),
      }),
    ),
  ]),
  questions: z.array(
    z.object({ name: z.string().optional(), instructions: z.string() }).and(
      z.discriminatedUnion("type", [
        z.object({ type: z.literal("predicate") }),
        z.object({
          type: z.literal("choice"),
          choices: z.array(
            z.object({
              value: z.union([z.string(), z.boolean()]),
              description: z.string().optional(),
            }),
          ),
        }),
        z.object({
          type: z.literal("score"),
          levels: z.array(
            z.object({ label: z.string(), description: z.string().optional() }),
          ),
        }),
      ]),
    ),
  ),
});

// Keep SDK prompt support independent of generated platform schema updates.
const promptBlockDataSchema = z.union([
  generatedPromptBlockDataSchema,
  decisionPromptSchema,
]);
export type PromptBlockData = z.infer<typeof promptBlockDataSchema>;

export const promptDataSchema = generatedPromptDataSchema.extend({
  prompt: promptBlockDataSchema.nullish(),
});
export type PromptData = z.infer<typeof promptDataSchema>;

// This roughly maps to promptBlockDataSchema, but is more ergonomic for the user.
export const promptContentsSchema = z.union([
  z.object({
    prompt: z.string(),
  }),
  z.object({
    messages: z.array(chatCompletionMessageParamSchema),
  }),
  decisionPromptSchema.omit({ type: true }),
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
  let promptBlock: PromptBlockData;
  if ("messages" in promptDefinition) {
    promptBlock = {
      type: "chat",
      messages: promptDefinition.messages,
      tools:
        rawTools && rawTools.length > 0 ? JSON.stringify(rawTools) : undefined,
    };
  } else if ("questions" in promptDefinition) {
    promptBlock = {
      type: "decisions",
      input: promptDefinition.input,
      questions: promptDefinition.questions,
    };
  } else {
    promptBlock = {
      type: "completion",
      content: promptDefinition.prompt,
    };
  }

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
