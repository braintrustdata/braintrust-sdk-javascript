import type {
  PromptDependencies,
  PromptJsonSchema,
  PromptMessage,
} from "./experimental-prompt-api";

type PromptAdapterInput = {
  kind: "messages" | "string";
  model?: string;
  inputSchema: { toJSONSchema(): PromptJsonSchema };
  outputSchema?: { toJSONSchema(): PromptJsonSchema };
  input: unknown;
  messages: PromptMessage[];
  content?: string;
  dependencies: PromptDependencies;
};

type OpenAIChatPromptArgs = {
  model?: string;
  messages: PromptMessage[];
  response_format?: {
    type: "json_schema";
    json_schema: {
      name: string;
      schema: PromptJsonSchema;
      strict: true;
    };
  };
  span_info: {
    metadata: {
      prompt: PromptDependencies;
    };
  };
};

type AISDKGenerateObjectPromptArgs = {
  model?: string;
  messages: PromptMessage[];
  schema?: PromptJsonSchema;
  experimental_telemetry: {
    metadata: {
      braintrustPrompt: PromptDependencies;
    };
  };
};

type OpenAIChatAdapterOptions = Record<string, never>;
type AISDKGenerateObjectAdapterOptions = Record<string, never>;

function schemaName(slug: string): string {
  const name = slug.replace(/[^a-zA-Z0-9_-]/g, "_");
  return name.length > 0 ? `${name}_output` : "prompt_output";
}

function openAIChatAdapter(
  options: OpenAIChatAdapterOptions = {},
): (builtPrompt: PromptAdapterInput) => OpenAIChatPromptArgs {
  void options;
  return (builtPrompt) => {
    const outputSchema = builtPrompt.outputSchema?.toJSONSchema();
    return {
      model: builtPrompt.model,
      messages: builtPrompt.messages,
      ...(outputSchema
        ? {
            response_format: {
              type: "json_schema" as const,
              json_schema: {
                name: schemaName(builtPrompt.dependencies.root.slug),
                schema: outputSchema,
                strict: true as const,
              },
            },
          }
        : undefined),
      span_info: {
        metadata: {
          prompt: builtPrompt.dependencies,
        },
      },
    };
  };
}

function aiSDKGenerateObjectAdapter(
  options: AISDKGenerateObjectAdapterOptions = {},
): (builtPrompt: PromptAdapterInput) => AISDKGenerateObjectPromptArgs {
  void options;
  return (builtPrompt) => ({
    model: builtPrompt.model,
    messages: builtPrompt.messages,
    schema: builtPrompt.outputSchema?.toJSONSchema(),
    experimental_telemetry: {
      metadata: {
        braintrustPrompt: builtPrompt.dependencies,
      },
    },
  });
}

export const adapters = {
  openAIChat: openAIChatAdapter,
  aiSDKGenerateObject: aiSDKGenerateObjectAdapter,
};
