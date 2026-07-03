import { BaseAttachment, ReadonlyAttachment } from "./logger";
import type { BraintrustState } from "./logger";
import type { AttachmentReferenceType as AttachmentReference } from "./generated_types";
import type {
  InlineAttachmentReference,
  PromptDependencies,
  PromptJsonSchema,
  PromptMessage,
  PromptMessageContentPart,
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
      prompt: PromptDependencies;
    };
  };
};

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
      braintrustPrompt: PromptDependencies;
    };
  };
};

type AdapterOptions = {
  state?: BraintrustState;
};

type OpenAIChatAdapterOptions = AdapterOptions;
type AISDKGenerateObjectAdapterOptions = AdapterOptions;

type ResolvedPromptFile = {
  data: string;
  contentType?: string;
  filename?: string;
  detail?: "auto" | "low" | "high";
};

function schemaName(slug: string): string {
  const name = slug.replace(/[^a-zA-Z0-9_-]/g, "_");
  return name.length > 0 ? `${name}_output` : "prompt_output";
}

function openAIChatAdapter(
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

function aiSDKGenerateObjectAdapter(
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

async function resolvePromptFile(
  part: Extract<PromptMessageContentPart, { type: "file" }>,
  options: AdapterOptions,
): Promise<ResolvedPromptFile> {
  const value = part.file.value;
  const optionContentType = part.file.contentType;
  const optionFilename = part.file.filename;

  if (value instanceof BaseAttachment || value instanceof ReadonlyAttachment) {
    const reference = value.reference;
    const data =
      value instanceof ReadonlyAttachment
        ? await value.asBase64Url()
        : await blobToDataUrl(await value.data(), reference.content_type);
    return {
      data,
      contentType: optionContentType ?? reference.content_type,
      filename: optionFilename ?? reference.filename,
      detail: part.file.detail,
    };
  }

  if (isAttachmentReference(value)) {
    const data = await new ReadonlyAttachment(
      value,
      options.state,
    ).asBase64Url();
    return {
      data,
      contentType: optionContentType ?? value.content_type,
      filename: optionFilename ?? value.filename,
      detail: part.file.detail,
    };
  }

  if (isInlineAttachmentReference(value)) {
    const data = value.data ?? value.src;
    return {
      data,
      contentType:
        optionContentType ?? value.content_type ?? contentTypeFromString(data),
      filename: optionFilename ?? value.filename,
      detail: part.file.detail,
    };
  }

  if (isBlob(value)) {
    const contentType = optionContentType ?? (value.type || undefined);
    return {
      data: await blobToDataUrl(value, contentType),
      contentType,
      filename: optionFilename,
      detail: part.file.detail,
    };
  }

  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const contentType = optionContentType ?? "application/octet-stream";
    return {
      data: await blobToDataUrl(
        new Blob([value as BlobPart], { type: contentType }),
        contentType,
      ),
      contentType,
      filename: optionFilename,
      detail: part.file.detail,
    };
  }

  if (typeof value === "string") {
    return {
      data: value,
      contentType: optionContentType ?? contentTypeFromString(value),
      filename: optionFilename,
      detail: part.file.detail,
    };
  }

  throw new Error("prompt.file value must be an attachment-compatible value");
}

function isImageFile(file: ResolvedPromptFile): boolean {
  if (file.contentType?.startsWith("image/")) {
    return true;
  }
  if (file.contentType && !file.contentType.startsWith("image/")) {
    return false;
  }
  return isHttpUrl(file.data);
}

function isLikelyFileId(value: string): boolean {
  return !isHttpUrl(value) && !value.startsWith("data:");
}

function contentTypeFromString(value: string): string | undefined {
  const dataUrlContentType = value.match(/^data:([^;,]+)[;,]/)?.[1];
  if (dataUrlContentType) {
    return dataUrlContentType;
  }

  const extension = value.split(/[?#]/, 1)[0]?.split(".").at(-1)?.toLowerCase();
  switch (extension) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "pdf":
      return "application/pdf";
    case "txt":
      return "text/plain";
    case "json":
      return "application/json";
    default:
      return undefined;
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isBlob(value: unknown): value is Blob {
  return typeof Blob !== "undefined" && value instanceof Blob;
}

function isAttachmentReference(value: unknown): value is AttachmentReference {
  return (
    isRecord(value) &&
    ((value.type === "braintrust_attachment" &&
      typeof value.key === "string" &&
      typeof value.filename === "string" &&
      typeof value.content_type === "string") ||
      (value.type === "external_attachment" &&
        typeof value.url === "string" &&
        typeof value.filename === "string" &&
        typeof value.content_type === "string"))
  );
}

function isInlineAttachmentReference(
  value: unknown,
): value is InlineAttachmentReference {
  return (
    isRecord(value) &&
    value.type === "inline_attachment" &&
    typeof value.src === "string" &&
    (value.content_type === undefined ||
      typeof value.content_type === "string") &&
    (value.filename === undefined || typeof value.filename === "string") &&
    (value.data === undefined || typeof value.data === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function blobToDataUrl(
  blob: Blob,
  contentType?: string,
): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const base64 =
    typeof Buffer !== "undefined"
      ? Buffer.from(buffer).toString("base64")
      : bytesToBase64(new Uint8Array(buffer));
  return `data:${contentType ?? (blob.type || "application/octet-stream")};base64,${base64}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export const adapters = {
  openAIChat: openAIChatAdapter,
  aiSDKGenerateObject: aiSDKGenerateObjectAdapter,
};
