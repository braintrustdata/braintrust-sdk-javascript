import type {
  ChatCompletionContentPartType,
  ChatCompletionMessageParamType,
} from "../generated_types";
import type {
  ExperimentalPromptData,
  PromptMessage,
  PromptMessageContentPart,
} from "../experimental-prompt-api";
import type { PromptDefinition as MustachePromptDefinition } from "../prompt-schemas";

/**
 * @internal Converts experimental prompt template data into the existing prompt
 * definition shape. This is intended for future backend-saving code paths.
 */
export function promptDefinitionToMustache(
  data: ExperimentalPromptData,
): MustachePromptDefinition {
  if (!data.model) {
    throw new Error("Cannot convert prompt data to mustache without a model");
  }

  if (data.kind === "messages") {
    return {
      model: data.model,
      messages: data.messages.map(promptMessageToMustacheMessage),
    };
  }

  return {
    model: data.model,
    messages: [{ role: "user", content: data.content }],
  };
}

function promptMessageToMustacheMessage(
  message: PromptMessage,
): ChatCompletionMessageParamType {
  if (typeof message.content === "string") {
    if (message.role === "system") {
      return { role: "system", content: message.content };
    }
    if (message.role === "assistant") {
      return { role: "assistant", content: message.content };
    }
    return { role: "user", content: message.content };
  }
  if (message.role !== "user") {
    throw new Error("Only user messages can contain prompt.file parts");
  }
  return {
    role: "user",
    content: message.content.map(promptContentPartToMustachePart),
  };
}

function promptContentPartToMustachePart(
  part: PromptMessageContentPart,
): ChatCompletionContentPartType {
  if (part.type === "text") {
    return part;
  }

  const value = stringifyTemplateValue(part.file.value);
  const contentType =
    part.file.contentType ??
    (typeof value === "string" ? dataUrlContentType(value) : undefined);
  if (isImageContentType(contentType)) {
    return {
      type: "image_url" as const,
      image_url: {
        url: value,
        ...(part.file.detail ? { detail: part.file.detail } : undefined),
      },
    };
  }

  return {
    type: "file" as const,
    file: {
      file_data: value,
      ...(part.file.filename ? { filename: part.file.filename } : undefined),
    },
  };
}

function stringifyTemplateValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  if (
    typeof value === "object" &&
    value !== null &&
    (typeof (value as { [Symbol.toPrimitive]?: unknown })[
      Symbol.toPrimitive
    ] === "function" ||
      Object.prototype.hasOwnProperty.call(value, "toString"))
  ) {
    return String(value);
  }
  return JSON.stringify(value) ?? "";
}

function dataUrlContentType(value: string): string | undefined {
  return value.match(/^data:([^;,]+)[;,]/)?.[1];
}

function isImageContentType(contentType: string | undefined): boolean {
  return contentType?.startsWith("image/") ?? false;
}
