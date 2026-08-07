import type {
  PromptMessage,
  PromptMessageContentPart,
} from "../experimental-prompt-api";
import type { PromptJsonSchema } from "../experimental-prompt-api-schema-utils";
import { isImageFile, resolvePromptFile } from "./utils";
import type { AdapterOptions, PromptAdapterInput } from "./types";

type AISDKContentPart =
  | { type: "text"; text: string }
  | { type: "image"; image: string; mediaType?: string }
  | { type: "file"; data: string; mediaType: string; filename?: string };

type AISDKMessage = Omit<PromptMessage, "content"> & {
  content: string | AISDKContentPart[];
};

type AISDKGenerateObjectPromptArgs = {
  model?: string;
  messages: AISDKMessage[];
  schema?: PromptJsonSchema;
  experimental_telemetry: {
    metadata: {
      braintrustPrompt: PromptAdapterInput["dependencies"];
    };
  };
};

type AISDKGenerateObjectAdapterOptions = AdapterOptions;

export function aiSDKGenerateObjectAdapter(
  options: AISDKGenerateObjectAdapterOptions = {},
): (builtPrompt: PromptAdapterInput) => Promise<AISDKGenerateObjectPromptArgs> {
  return async (builtPrompt) => ({
    model: builtPrompt.model,
    messages: await Promise.all(
      builtPrompt.messages.map((message) =>
        renderAISDKMessage(message, options),
      ),
    ),
    schema: builtPrompt.outputSchema?.toJSONSchema(),
    experimental_telemetry: {
      metadata: {
        braintrustPrompt: builtPrompt.dependencies,
      },
    },
  });
}

async function renderAISDKMessage(
  message: PromptMessage,
  options: AdapterOptions,
): Promise<AISDKMessage> {
  if (typeof message.content === "string") {
    return message as AISDKMessage;
  }
  return {
    ...message,
    content: await Promise.all(
      message.content.map((part) => renderAISDKContentPart(part, options)),
    ),
  };
}

async function renderAISDKContentPart(
  part: PromptMessageContentPart,
  options: AdapterOptions,
): Promise<AISDKContentPart> {
  if (part.type === "text") {
    return part;
  }

  const resolved = await resolvePromptFile(part, options);
  if (isImageFile(resolved)) {
    return {
      type: "image",
      image: resolved.data,
      ...(resolved.contentType
        ? { mediaType: resolved.contentType }
        : undefined),
    };
  }

  return {
    type: "file",
    data: resolved.data,
    mediaType: resolved.contentType ?? "application/octet-stream",
    ...(resolved.filename ? { filename: resolved.filename } : undefined),
  };
}
