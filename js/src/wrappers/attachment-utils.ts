import { Attachment } from "../logger";

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
    "audio/wav": "wav",
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
export function processInputAttachments(input: any): any {
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
      return node.map(processNode);
    }

    if (!node || typeof node !== "object") {
      return node;
    }

    // OpenAI chat image_url content format
    if (
      node.type === "image_url" &&
      node.image_url &&
      typeof node.image_url === "object" &&
      typeof node.image_url.url === "string" &&
      node.image_url.url.startsWith("data:")
    ) {
      const mediaType = inferMediaTypeFromDataUrl(
        node.image_url.url,
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
      typeof node.file.file_data === "string" &&
      node.file.file_data.startsWith("data:")
    ) {
      const mediaType = inferMediaTypeFromDataUrl(
        node.file.file_data,
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
      let mediaType = "image/png";
      if (typeof node.image === "string" && node.image.startsWith("data:")) {
        mediaType = inferMediaTypeFromDataUrl(node.image, mediaType);
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

    // AI SDK file content format
    if (node.type === "file" && node.data) {
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
      processed[key] = processNode(value);
    }
    return processed;
  };

  if (Array.isArray(input)) {
    return input.map(processNode);
  }

  return processNode(input);
}
