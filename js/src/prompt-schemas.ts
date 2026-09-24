import type {
  ToolFunctionDefinition,
  ChatCompletionMessageParam,
  ModelParams,
  PromptBlockData,
  PromptData,
} from "./sdk-types";

// This roughly maps to promptBlockDataSchema, but is more ergonomic for the user.
export type PromptContents =
  | { prompt: string }
  | { messages: ChatCompletionMessageParam[] };

export type PromptDefinition = PromptContents & {
  model: string;
  params?: ModelParams;
  templateFormat?: "mustache" | "nunjucks" | "none";
  environments?: string[];
};

export type PromptDefinitionWithTools = PromptDefinition & {
  tools?: ToolFunctionDefinition[];
};

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
