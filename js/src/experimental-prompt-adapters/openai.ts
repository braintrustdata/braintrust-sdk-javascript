import type {
  PromptMessage,
  PromptMessageContentPart,
} from "../experimental-prompt-api";
import type { PromptJsonSchema } from "../experimental-prompt-api-schema-utils";
import type { AdapterOptions, PromptAdapterInput } from "./types";
import { isImageFile, isLikelyFileId, resolvePromptFile } from "./utils";

type OpenAIContentPart =
  | { type: "text"; text: string }
  | {
      type: "image_url";
      image_url: { url: string; detail?: "auto" | "low" | "high" };
    }
  | {
      type: "file";
      file: { file_data?: string; file_id?: string; filename?: string };
    };

type OpenAIChatMessage = Omit<PromptMessage, "content"> & {
  content: string | OpenAIContentPart[];
};

type OpenAIChatPromptArgs = {
  model?: string;
  messages: OpenAIChatMessage[];
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
      prompt: PromptAdapterInput["dependencies"];
    };
  };
};

type OpenAIChatAdapterOptions = AdapterOptions;

function schemaName(slug: string): string {
  const name = slug.replace(/[^a-zA-Z0-9_-]/g, "_");
  return name.length > 0 ? `${name}_output` : "prompt_output";
}

export function openAIChatAdapter(
  options: OpenAIChatAdapterOptions = {},
): (builtPrompt: PromptAdapterInput) => Promise<OpenAIChatPromptArgs> {
  return async (builtPrompt) => {
    const outputSchema = builtPrompt.outputSchema?.toJSONSchema();
    return {
      model: builtPrompt.model,
      messages: await Promise.all(
        builtPrompt.messages.map((message) =>
          renderOpenAIMessage(message, options),
        ),
      ),
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

async function renderOpenAIMessage(
  message: PromptMessage,
  options: AdapterOptions,
): Promise<OpenAIChatMessage> {
  if (typeof message.content === "string") {
    return message as OpenAIChatMessage;
  }
  return {
    ...message,
    content: await Promise.all(
      message.content.map((part) => renderOpenAIContentPart(part, options)),
    ),
  };
}

async function renderOpenAIContentPart(
  part: PromptMessageContentPart,
  options: AdapterOptions,
): Promise<OpenAIContentPart> {
  if (part.type === "text") {
    return part;
  }

  const resolved = await resolvePromptFile(part, options);
  if (isImageFile(resolved)) {
    return {
      type: "image_url",
      image_url: {
        url: resolved.data,
        ...(resolved.detail ? { detail: resolved.detail } : undefined),
      },
    };
  }

  return {
    type: "file",
    file: isLikelyFileId(resolved.data)
      ? {
          file_id: resolved.data,
          ...(resolved.filename ? { filename: resolved.filename } : undefined),
        }
      : {
          file_data: resolved.data,
          ...(resolved.filename ? { filename: resolved.filename } : undefined),
        },
  };
}
