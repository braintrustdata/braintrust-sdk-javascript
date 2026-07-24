import { BaseAttachment, ReadonlyAttachment } from "../logger";
import type { AttachmentReferenceType as AttachmentReference } from "../generated_types";
import type {
  InlineAttachmentReference,
  PromptMessageContentPart,
} from "../experimental-prompt-api";
import type { AdapterOptions } from "./types";

export type ResolvedPromptFile = {
  data: string;
  contentType?: string;
  filename?: string;
  detail?: "auto" | "low" | "high";
};

export async function resolvePromptFile(
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

export function isImageFile(file: ResolvedPromptFile): boolean {
  if (file.contentType?.startsWith("image/")) {
    return true;
  }
  if (file.contentType && !file.contentType.startsWith("image/")) {
    return false;
  }
  return isHttpUrl(file.data);
}

export function isLikelyFileId(value: string): boolean {
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
