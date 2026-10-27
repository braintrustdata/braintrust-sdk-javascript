import { debugLogger } from "./debug-logger";
import { Attachment } from "./logger/core";
import { uint8ArrayToBase64 } from "../util/bytes";
import { isObject } from "../util/type_util";
import {
  convertDataToBlob,
  getExtensionFromMediaType,
  isAutoCaptureAttachmentsEnabled,
} from "./wrappers/attachment-utils";

/** Walk logged decision/extraction JSON without changing provider-owned containers. */
function mapTypedMedia(
  value: unknown,
  media: (data: unknown, mediaType?: string, filename?: string) => unknown,
  omitDeepValues = false,
  depth = 0,
): unknown {
  if (value instanceof URL)
    return value.protocol === "data:" ? media(value.href) : value.href;
  if (typeof value === "string" && /^data:[^,\s]*,[^\s]*$/.test(value)) {
    return media(value);
  }
  if (
    value instanceof Attachment ||
    (isObject(value) &&
      (value.type === "braintrust_attachment" ||
        value.type === "external_attachment" ||
        value.type === "inline_attachment"))
  )
    return value;
  // An unvisited container may hide inline media. Capture-disabled logging must
  // omit it rather than using the capture-enabled original-payload fallback.
  if (depth >= 128) {
    return omitDeepValues && value !== null && typeof value === "object"
      ? "<omitted>"
      : value;
  }
  if (Array.isArray(value)) {
    return value.map((part) =>
      mapTypedMedia(part, media, omitDeepValues, depth + 1),
    );
  }
  if (!isObject(value)) return value;
  // Preserve SDK objects and other non-JSON values rather than walking internals.
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      value.type === "file" && key === "data"
        ? isObject(child) && child.type === "data"
          ? {
              ...child,
              data: media(
                child.data,
                typeof value.mediaType === "string"
                  ? value.mediaType
                  : undefined,
                typeof value.filename === "string" ? value.filename : undefined,
              ),
            }
          : media(
              child,
              typeof value.mediaType === "string" ? value.mediaType : undefined,
              typeof value.filename === "string" ? value.filename : undefined,
            )
        : mapTypedMedia(child, media, omitDeepValues, depth + 1),
    ]),
  );
}

// IDs, question types, and selected choice keys are identifiers, not media.
// Scan only the values supported by the typed decision/extraction envelopes.
function mapTypedPayload(
  value: unknown,
  media: (data: unknown, mediaType?: string, filename?: string) => unknown,
  omitDeepValues = false,
): unknown {
  if (!isObject(value)) return value;
  return {
    ...value,
    ...("state" in value
      ? { state: mapTypedMedia(value.state, media, omitDeepValues) }
      : {}),
    ...("images" in value
      ? { images: mapTypedMedia(value.images, media, omitDeepValues) }
      : {}),
    ...(Array.isArray(value.questions)
      ? {
          questions: value.questions.map((question) => {
            if (!isObject(question)) return question;
            return {
              ...question,
              ...("instructions" in question
                ? {
                    instructions: mapTypedMedia(
                      question.instructions,
                      media,
                      omitDeepValues,
                    ),
                  }
                : {}),
              ...("criteria" in question
                ? {
                    criteria: mapTypedMedia(
                      question.criteria,
                      media,
                      omitDeepValues,
                    ),
                  }
                : {}),
            };
          }),
        }
      : {}),
    ...(Array.isArray(value.answers)
      ? {
          answers: value.answers.map((answer) =>
            isObject(answer) && "legend" in answer
              ? {
                  ...answer,
                  legend: mapTypedMedia(answer.legend, media, omitDeepValues),
                }
              : answer,
          ),
        }
      : {}),
  };
}

/** Apply capture privacy and snapshot binary inputs; conversion waits for export. */
export function prepareTypedAttachments(value: unknown): unknown {
  const capture = isAutoCaptureAttachmentsEnabled();
  return mapTypedPayload(
    value,
    (data) => {
      if (data instanceof URL) data = data.href;
      if (typeof data === "string" && /^https?:/i.test(data)) return data;
      if (
        isObject(data) &&
        !(data instanceof Uint8Array) &&
        !(data instanceof ArrayBuffer)
      )
        return data;
      if (!capture) return "<omitted>";
      if (data instanceof Uint8Array) return uint8ArrayToBase64(data);
      if (data instanceof ArrayBuffer)
        return uint8ArrayToBase64(new Uint8Array(data));
      return data;
    },
    !capture,
  );
}

/** Per-exporter automatic decision/extraction uploads, after customization and masking. */
export class TypedAttachmentProcessor {
  private uploadFailed = false;

  async process<T extends object>(
    record: T,
    captureAttachments = isAutoCaptureAttachmentsEnabled(),
  ): Promise<T> {
    if (this.uploadFailed || !captureAttachments) return record;
    const payload = record as { input?: unknown; output?: unknown };
    const input =
      isObject(payload.input) &&
      "state" in payload.input &&
      (Array.isArray(payload.input.questions) ||
        Array.isArray(payload.input.fields));
    const output =
      isObject(payload.output) && Array.isArray(payload.output.answers);
    if (!input && !output) return record;

    const attachments: Attachment[] = [];
    let converted: T;
    try {
      const convert = (
        data: unknown,
        mediaType?: string,
        filename?: string,
      ): unknown => {
        if (data instanceof URL) data = data.href;
        if (typeof data === "string" && /^https?:/i.test(data)) return data;
        if (
          isObject(data) &&
          !(data instanceof Uint8Array) &&
          !(data instanceof ArrayBuffer)
        )
          return data;
        if (typeof data === "string" && data.startsWith("data:")) {
          const match = /^data:([^;,]+);base64,([^\s]*)$/.exec(data);
          if (!match) return data;
          mediaType = match[1];
        }
        // A declared MIME type is resolved even when our filename extension
        // table has no entry for it (including application/octet-stream).
        // Reject missing/invalid types without guessing or sniffing the bytes.
        if (
          !mediaType ||
          !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(
            mediaType,
          )
        )
          return data;
        const blob = convertDataToBlob(data, mediaType);
        if (!blob) throw new Error("Invalid typed media");
        const attachment = new Attachment({
          data: blob,
          contentType: mediaType,
          filename:
            filename ?? `attachment.${getExtensionFromMediaType(mediaType)}`,
        });
        attachments.push(attachment);
        return attachment.reference;
      };
      // Stage every replacement before accepting any upload. A conversion or
      // local enqueue failure discards the entire rewrite, including output.
      converted = {
        ...record,
        ...(input ? { input: mapTypedPayload(payload.input, convert) } : {}),
        ...(output ? { output: mapTypedPayload(payload.output, convert) } : {}),
      };
    } catch {
      return record;
    }
    for (const attachment of attachments) {
      try {
        const status = await attachment.upload();
        if (status.upload_status !== "done")
          throw new Error("Attachment upload failed");
      } catch {
        this.uploadFailed = true;
        // No exception details: upload failures may contain sensitive values.
        debugLogger.warn(
          "Typed attachment uploads disabled after an upload failure; exporting inline media.",
        );
        return record;
      }
    }
    return converted;
  }
}
