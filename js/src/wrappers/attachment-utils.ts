import {
  Attachment,
  BaseAttachment,
  _internalCaptureAttachmentsEnabled,
} from "../logger";

/** Remove media fields without reading their values, dropping type-only blocks. */
export function omitMediaData(
  value: object,
  ...fields: string[]
): Record<string, unknown> | undefined {
  const result: Record<string, unknown> = {};
  let hasContent = false;
  for (const key of Object.keys(value)) {
    if (fields.includes(key)) continue;
    const item: unknown = Reflect.get(value, key);
    if (item === undefined) continue;
    Object.defineProperty(result, key, {
      value: item,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    if (key !== "type") hasContent = true;
  }
  return hasContent ? result : undefined;
}

/**
 * Get file extension from IANA media type
 */
export function getExtensionFromMediaType(mediaType: string): string {
  const extensionMap: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "audio/mpeg": "mp3",
    "audio/aac": "aac",
    "audio/pcm": "pcm",
    "audio/flac": "flac",
    "audio/basic": "mulaw",
    "audio/mp4": "m4a",
    "audio/wav": "wav",
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "application/pdf": "pdf",
    "application/json": "json",
    "text/plain": "txt",
    "text/html": "html",
    "text/csv": "csv",
  };

  return extensionMap[mediaType] || "bin";
}

/**
 * Converts data (base64 string, URL, ArrayBuffer, Uint8Array, etc.) to a Blob
 */
export function convertDataToBlob(data: any, mediaType: string): Blob | null {
  try {
    if (data instanceof URL) {
      if (data.protocol !== "data:") return null;
      data = data.href;
    }
    if (typeof data === "string") {
      // Could be base64, data URL, or regular URL
      if (data.startsWith("data:")) {
        // Data URL - extract the base64 part
        const base64Match = data.match(/^data:[^;]+;base64,(.+)$/);
        if (base64Match) {
          const base64 = base64Match[1];
          const binaryString = atob(base64);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }
          return new Blob([bytes], { type: mediaType });
        }
      } else if (data.startsWith("http://") || data.startsWith("https://")) {
        // URL - we can't fetch it here, so return null to skip
        return null;
      } else {
        // Assume raw base64
        const binaryString = atob(data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        return new Blob([bytes], { type: mediaType });
      }
    } else if (data instanceof Uint8Array) {
      return new Blob([data as any], { type: mediaType });
    } else if (data instanceof ArrayBuffer) {
      return new Blob([data as any], { type: mediaType });
    } else if (typeof Buffer !== "undefined" && data instanceof Buffer) {
      return new Blob([data as any], { type: mediaType });
    }
  } catch {
    // If conversion fails, return null
    return null;
  }
  return null;
}

/**
 * Process input to extract and convert image/file content parts to Attachments
 * Similar to processImagesInOutput in oai_responses.ts - replaces data in-place
 */
export function processInputAttachments(
  input: any,
  captureAttachments = _internalCaptureAttachmentsEnabled(),
  audioOutputFormat?: string,
): any {
  if (!input) {
    return input;
  }

  let attachmentIndex = 0;

  const inferMediaTypeFromDataUrl = (
    value: string,
    fallback: string,
  ): string => {
    const mediaTypeMatch = value.match(/^data:([^;]+);/);
    return mediaTypeMatch?.[1] || fallback;
  };

  const toAttachment = (
    value: unknown,
    mediaType: string,
    filename: string,
  ): Attachment | null => {
    const blob = convertDataToBlob(value, mediaType);
    if (!blob) {
      return null;
    }

    return new Attachment({
      data: blob,
      filename,
      contentType: mediaType,
    });
  };

  const processNode = (node: any): any => {
    if (Array.isArray(node)) {
      return node.map(processNode).filter((item) => item !== undefined);
    }

    if (!node || typeof node !== "object") {
      return node;
    }

    if (node instanceof BaseAttachment || node instanceof Date) return node;
    // Tool arguments and JSON results are application data, not content parts.
    if (node.type === "tool-call") return node;
    if (node.type === "tool-result") {
      return node.output?.type === "content" && Array.isArray(node.output.value)
        ? {
            ...node,
            output: { ...node.output, value: processNode(node.output.value) },
          }
        : node;
    }
    if (node instanceof URL) {
      if (node.protocol !== "data:") return node;
      if (!captureAttachments) return undefined;
      const mediaType = inferMediaTypeFromDataUrl(
        node.href,
        "application/octet-stream",
      );
      return (
        toAttachment(
          node,
          mediaType,
          `file.${getExtensionFromMediaType(mediaType)}`,
        ) ?? node
      );
    }

    // Responses API and Agents SDK image/file content parts.
    if (node.type === "input_image" || node.type === "input_file") {
      const field =
        node.type === "input_file"
          ? "file_data" in node
            ? "file_data"
            : "file"
          : "image_url" in node
            ? "image_url"
            : "image";
      const data = node[field];
      if (data instanceof BaseAttachment) return node;
      if (typeof data === "string" || data instanceof URL) {
        if (
          (data instanceof URL && data.protocol !== "data:") ||
          /^https?:/i.test(String(data))
        )
          return node;
        if (!captureAttachments) return omitMediaData(node, field);
        const mediaType = inferMediaTypeFromDataUrl(
          String(data),
          node.type === "input_image"
            ? "image/png"
            : "application/octet-stream",
        );
        const filename =
          node.filename || `file.${getExtensionFromMediaType(mediaType)}`;
        const attachment = toAttachment(data, mediaType, filename);
        if (attachment) return { ...node, [field]: attachment };
      }
    }

    if (node.type === "audio" && typeof node.audio === "string") {
      if (!captureAttachments) return omitMediaData(node, "audio");
      const format = node.format || "wav";
      const attachment = toAttachment(
        node.audio,
        format === "mp3" ? "audio/mpeg" : `audio/${format}`,
        `audio.${format}`,
      );
      if (attachment) return { ...node, audio: attachment };
    }

    const audioField = node.type === "input_audio" ? "input_audio" : "audio";
    if (
      (node.type === "input_audio" || node.role === "assistant") &&
      node[audioField] &&
      typeof node[audioField] === "object"
    ) {
      const audio = node[audioField];
      if (audio.data instanceof BaseAttachment) return node;
      if (!captureAttachments)
        return omitMediaData({
          ...node,
          [audioField]: omitMediaData(audio, "data"),
        });
      const format =
        audio.format ||
        (node.role === "assistant" ? audioOutputFormat : undefined) ||
        "wav";
      const mediaType =
        format === "mp3"
          ? "audio/mpeg"
          : format === "opus"
            ? "audio/ogg"
            : format === "pcm16"
              ? "audio/pcm"
              : `audio/${format}`;
      const attachment = toAttachment(
        audio.data,
        mediaType,
        `audio.${getExtensionFromMediaType(mediaType)}`,
      );
      if (attachment)
        return { ...node, [audioField]: { ...audio, data: attachment } };
    }

    // AI SDK generateText/streamText file parts wrap a GeneratedFile instance.
    if (
      node.type === "file" &&
      node.file &&
      typeof node.file === "object" &&
      ("base64" in node.file || "uint8Array" in node.file)
    ) {
      if (!captureAttachments) return omitMediaData(node, "file");
      const mediaType = node.file.mediaType || "application/octet-stream";
      const attachment = toAttachment(
        node.file.base64 ?? node.file.uint8Array,
        mediaType,
        `file.${getExtensionFromMediaType(mediaType)}`,
      );
      if (attachment) return { ...node, file: attachment };
    }

    // OpenAI chat image_url content format
    if (
      node.type === "image_url" &&
      node.image_url &&
      typeof node.image_url === "object" &&
      ((typeof node.image_url.url === "string" &&
        node.image_url.url.startsWith("data:")) ||
        (node.image_url.url instanceof URL &&
          node.image_url.url.protocol === "data:"))
    ) {
      if (!captureAttachments)
        return omitMediaData({
          ...node,
          image_url: omitMediaData(node.image_url, "url"),
        });
      const mediaType = inferMediaTypeFromDataUrl(
        String(node.image_url.url),
        "image/png",
      );
      const filename = `image.${getExtensionFromMediaType(mediaType)}`;
      const attachment = toAttachment(node.image_url.url, mediaType, filename);

      if (attachment) {
        return {
          ...node,
          image_url: {
            ...node.image_url,
            url: attachment,
          },
        };
      }
    }

    // Voyage AI multimodal image_base64/video_base64 content format
    const voyageBase64Key =
      node.type === "image_base64"
        ? Object.hasOwn(node, "imageBase64")
          ? "imageBase64"
          : "image_base64"
        : node.type === "video_base64"
          ? Object.hasOwn(node, "videoBase64")
            ? "videoBase64"
            : "video_base64"
          : undefined;
    const voyageBase64Value = voyageBase64Key
      ? node[voyageBase64Key]
      : undefined;
    if (
      voyageBase64Key &&
      typeof voyageBase64Value === "string" &&
      voyageBase64Value.startsWith("data:")
    ) {
      if (!captureAttachments) return omitMediaData(node, voyageBase64Key);
      const mediaType = inferMediaTypeFromDataUrl(
        voyageBase64Value,
        node.type === "video_base64" ? "video/mp4" : "image/png",
      );
      const filename = `${node.type === "video_base64" ? "video" : "image"}.${getExtensionFromMediaType(mediaType)}`;
      const attachment = toAttachment(voyageBase64Value, mediaType, filename);

      if (attachment) {
        return {
          ...node,
          [voyageBase64Key]: attachment,
        };
      }
    }

    // OpenAI chat file content format
    if (
      node.type === "file" &&
      node.file &&
      typeof node.file === "object" &&
      ((typeof node.file.file_data === "string" &&
        !/^https?:/i.test(node.file.file_data)) ||
        (node.file.file_data instanceof URL &&
          node.file.file_data.protocol === "data:"))
    ) {
      if (!captureAttachments)
        return omitMediaData({
          ...node,
          file: omitMediaData(node.file, "file_data"),
        });
      const mediaType = inferMediaTypeFromDataUrl(
        String(node.file.file_data),
        "application/octet-stream",
      );
      const filename =
        typeof node.file.filename === "string" && node.file.filename
          ? node.file.filename
          : `document.${getExtensionFromMediaType(mediaType)}`;
      const attachment = toAttachment(node.file.file_data, mediaType, filename);

      if (attachment) {
        return {
          ...node,
          file: {
            ...node.file,
            file_data: attachment,
          },
        };
      }
    }

    // AI SDK image content format
    if (node.type === "image" && node.image) {
      if (node.image instanceof BaseAttachment) {
        attachmentIndex++;
        return node;
      }
      if (!captureAttachments) {
        return (node.image instanceof URL && node.image.protocol !== "data:") ||
          (typeof node.image === "string" && /^https?:/i.test(node.image))
          ? node
          : omitMediaData(node, "image");
      }
      let mediaType = "image/png";
      const image = node.image instanceof URL ? node.image.href : node.image;
      if (typeof image === "string" && image.startsWith("data:")) {
        mediaType = inferMediaTypeFromDataUrl(image, mediaType);
      } else if (node.mediaType) {
        mediaType = node.mediaType;
      }

      const filename = `input_image_${attachmentIndex}.${getExtensionFromMediaType(mediaType)}`;
      const attachment = toAttachment(node.image, mediaType, filename);

      if (attachment) {
        attachmentIndex++;
        return {
          ...node,
          image: attachment,
        };
      }
    }

    // AI SDK file parts and inline media in tool-result content.
    if (
      ["file", "image-data", "file-data", "media"].includes(node.type) &&
      node.data
    ) {
      if (node.data instanceof BaseAttachment) {
        attachmentIndex++;
        return node;
      }
      if (!captureAttachments) {
        return (node.data instanceof URL && node.data.protocol !== "data:") ||
          (typeof node.data === "string" && /^https?:/i.test(node.data))
          ? node
          : omitMediaData(node, "data");
      }
      const mediaType = node.mediaType || "application/octet-stream";
      const filename =
        node.filename ||
        `input_file_${attachmentIndex}.${getExtensionFromMediaType(mediaType)}`;
      const attachment = toAttachment(node.data, mediaType, filename);

      if (attachment) {
        attachmentIndex++;
        return {
          ...node,
          data: attachment,
        };
      }
    }

    const processed: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      const result = processNode(value);
      if (result !== undefined) processed[key] = result;
    }
    return processed;
  };

  if (Array.isArray(input)) {
    return input.map(processNode).filter((item) => item !== undefined);
  }

  return processNode(input);
}
