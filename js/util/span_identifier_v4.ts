// SpanComponentsV4: Binary serialization like V3 but with hex string compression
// Uses 16-byte encoding for trace IDs and 8-byte encoding for span IDs

import {
  SpanComponentsV3,
  SpanObjectTypeV3,
  spanObjectTypeV3EnumSchema,
} from "./span_identifier_v3";
import {
  ParentExperimentIds,
  ParentProjectLogIds,
  ParentPlaygroundLogIds,
} from "./object";
import {
  base64ToUint8Array,
  concatUint8Arrays,
  stringToUint8Array,
  uint8ArrayToBase64,
  uint8ArrayToString,
} from "./bytes";
import { z } from "zod/v3";
import { InvokeFunctionType as InvokeFunctionRequest } from "./generated_types";
import { mergeDicts } from "./object_util";

const ENCODING_VERSION_NUMBER_V4 = 4;

/**
 * Try to convert hex string to 16-byte binary (for trace IDs)
 */
function tryMakeHexTraceId(
  s: string,
): { bytes: Uint8Array; isHex: true } | { bytes: undefined; isHex: false } {
  try {
    if (typeof s === "string" && s.length === 32) {
      // 32 hex chars = 16 bytes
      const bytes = new Uint8Array(16);
      for (let i = 0; i < 16; i++) {
        const hex = s.substr(i * 2, 2);
        const byte = parseInt(hex, 16);
        if (isNaN(byte)) throw new Error();
        bytes[i] = byte;
      }
      return { bytes, isHex: true };
    }
  } catch {
    // Fall through
  }
  return { bytes: undefined, isHex: false };
}

/**
 * Try to convert hex string to 8-byte binary (for span IDs)
 */
function tryMakeHexSpanId(
  s: string,
): { bytes: Uint8Array; isHex: true } | { bytes: undefined; isHex: false } {
  try {
    if (typeof s === "string" && s.length === 16) {
      // 16 hex chars = 8 bytes
      const bytes = new Uint8Array(8);
      for (let i = 0; i < 8; i++) {
        const hex = s.substr(i * 2, 2);
        const byte = parseInt(hex, 16);
        if (isNaN(byte)) throw new Error();
        bytes[i] = byte;
      }
      return { bytes, isHex: true };
    }
  } catch {
    // Fall through
  }
  return { bytes: undefined, isHex: false };
}

const INVALID_ENCODING_ERRMSG_V4 = `SpanComponents string is not properly encoded. This library only supports encoding versions up to ${ENCODING_VERSION_NUMBER_V4}. Please make sure the SDK library used to decode the SpanComponents is at least as new as any library used to encode it.`;

enum Fields {
  OBJECT_ID = 1,
  ROW_ID = 2,
  SPAN_ID = 3, // 8-byte hex
  ROOT_SPAN_ID = 4, // 16-byte hex
}

const FIELDS_ID_TO_NAME: Record<Fields, string> = {
  [Fields.OBJECT_ID]: "object_id",
  [Fields.ROW_ID]: "row_id",
  [Fields.SPAN_ID]: "span_id",
  [Fields.ROOT_SPAN_ID]: "root_span_id",
};

export const spanComponentsV4Schema = z
  .object({
    object_type: spanObjectTypeV3EnumSchema,
    propagated_event: z.record(z.unknown()).nullish(),
  })
  .and(
    z.union([
      // Must provide one or the other.
      z.object({
        object_id: z.string().nullish(),
        compute_object_metadata_args: z.optional(z.null()),
      }),
      z.object({
        object_id: z.optional(z.null()),
        compute_object_metadata_args: z.record(z.unknown()),
      }),
    ]),
  )
  .and(
    z.union([
      // Either all of these must be provided or none.
      z.object({
        row_id: z.string(),
        span_id: z.string(),
        root_span_id: z.string(),
      }),
      z.object({
        row_id: z.optional(z.null()),
        span_id: z.optional(z.null()),
        root_span_id: z.optional(z.null()),
      }),
    ]),
  );

export type SpanComponentsV4Data = z.infer<typeof spanComponentsV4Schema>;

export class SpanComponentsV4 {
  constructor(public data: SpanComponentsV4Data) {}

  public toStr(): string {
    // V4-style binary encoding with hex string compression
    // Binary format: version_byte + object_type_byte + num_hex_fields + hex_entries + json_remainder
    const jsonObj: Record<string, unknown> = {
      compute_object_metadata_args:
        this.data.compute_object_metadata_args || undefined,
      propagated_event: this.data.propagated_event || undefined,
    };

    // Filter out undefined values
    Object.keys(jsonObj).forEach((key) => {
      if (jsonObj[key] === undefined) {
        delete jsonObj[key];
      }
    });

    const allBuffers: Array<Uint8Array> = [];
    allBuffers.push(
      new Uint8Array([ENCODING_VERSION_NUMBER_V4, this.data.object_type]),
    );

    const hexEntries: Array<Uint8Array> = [];

    function addHexField(origVal: string, fieldId: Fields) {
      let hexResult:
        | { bytes: Uint8Array; isHex: true }
        | { bytes: undefined; isHex: false };

      if (fieldId === Fields.SPAN_ID) {
        hexResult = tryMakeHexSpanId(origVal);
      } else if (fieldId === Fields.ROOT_SPAN_ID) {
        hexResult = tryMakeHexTraceId(origVal);
      } else {
        hexResult = { bytes: undefined, isHex: false };
      }

      if (hexResult.isHex) {
        hexEntries.push(
          concatUint8Arrays(new Uint8Array([fieldId]), hexResult.bytes),
        );
      } else {
        jsonObj[FIELDS_ID_TO_NAME[fieldId]] = origVal;
      }
    }

    if (this.data.object_id) {
      addHexField(this.data.object_id, Fields.OBJECT_ID);
    }
    if (this.data.row_id) {
      addHexField(this.data.row_id, Fields.ROW_ID);
    }
    if (this.data.span_id) {
      addHexField(this.data.span_id, Fields.SPAN_ID);
    }
    if (this.data.root_span_id) {
      addHexField(this.data.root_span_id, Fields.ROOT_SPAN_ID);
    }

    if (hexEntries.length > 255) {
      throw new Error("Impossible: too many hex entries to encode");
    }

    allBuffers.push(new Uint8Array([hexEntries.length]));
    allBuffers.push(...hexEntries);

    if (Object.keys(jsonObj).length > 0) {
      allBuffers.push(stringToUint8Array(JSON.stringify(jsonObj)));
    }

    return uint8ArrayToBase64(concatUint8Arrays(...allBuffers));
  }

  public static fromStr(s: string): SpanComponentsV4 {
    try {
      const rawBytes = base64ToUint8Array(s);
      const jsonObj: Record<string, unknown> = {};

      if (rawBytes[0] < ENCODING_VERSION_NUMBER_V4) {
        // Handle older versions by delegating to V3
        const v3Components = SpanComponentsV3.fromStr(s);
        jsonObj["object_type"] = v3Components.data.object_type;
        jsonObj["object_id"] = v3Components.data.object_id;
        jsonObj["compute_object_metadata_args"] =
          v3Components.data.compute_object_metadata_args;
        jsonObj["row_id"] = v3Components.data.row_id;
        jsonObj["span_id"] = v3Components.data.span_id;
        jsonObj["root_span_id"] = v3Components.data.root_span_id;
        jsonObj["propagated_event"] = v3Components.data.propagated_event;
      } else {
        // V4 binary format
        jsonObj["object_type"] = rawBytes[1];
        const numHexEntries = rawBytes[2];
        let byteOffset = 3;

        for (let i = 0; i < numHexEntries; i++) {
          const fieldId = rawBytes[byteOffset] as Fields;
          if (fieldId === Fields.SPAN_ID) {
            // 8-byte span ID
            const hexBytes = rawBytes.subarray(byteOffset + 1, byteOffset + 9);
            byteOffset += 9;
            jsonObj[FIELDS_ID_TO_NAME[fieldId]] = Array.from(hexBytes, (b) =>
              b.toString(16).padStart(2, "0"),
            ).join("");
          } else if (fieldId === Fields.ROOT_SPAN_ID) {
            // 16-byte trace ID
            const hexBytes = rawBytes.subarray(byteOffset + 1, byteOffset + 17);
            byteOffset += 17;
            jsonObj[FIELDS_ID_TO_NAME[fieldId]] = Array.from(hexBytes, (b) =>
              b.toString(16).padStart(2, "0"),
            ).join("");
          } else {
            // Should not happen for object_id/row_id in V4, but handle gracefully
            const hexBytes = rawBytes.subarray(byteOffset + 1, byteOffset + 17); // assume 16 bytes
            byteOffset += 17;
            jsonObj[FIELDS_ID_TO_NAME[fieldId]] = Array.from(hexBytes, (b) =>
              b.toString(16).padStart(2, "0"),
            ).join("");
          }
        }

        if (byteOffset < rawBytes.length) {
          const remainingJsonObj = JSON.parse(
            uint8ArrayToString(rawBytes.subarray(byteOffset)),
          );
          Object.assign(jsonObj, remainingJsonObj);
        }
      }

      return SpanComponentsV4.fromJsonObj(jsonObj);
    } catch {
      throw new Error(INVALID_ENCODING_ERRMSG_V4);
    }
  }

  public objectIdFields():
    | ParentExperimentIds
    | ParentProjectLogIds
    | ParentPlaygroundLogIds {
    if (!this.data.object_id) {
      throw new Error(
        "Impossible: cannot invoke `objectIdFields` unless SpanComponentsV4 is initialized with an `object_id`",
      );
    }
    switch (this.data.object_type) {
      case SpanObjectTypeV3.EXPERIMENT:
        return { experiment_id: this.data.object_id };
      case SpanObjectTypeV3.PROJECT_LOGS:
        return { project_id: this.data.object_id, log_id: "g" };
      case SpanObjectTypeV3.PLAYGROUND_LOGS:
        return { prompt_session_id: this.data.object_id, log_id: "x" };
      default:
        this.data.object_type satisfies never;
        throw new Error(`Invalid object_type ${this.data.object_type}`);
    }
  }

  public async export(): Promise<string> {
    return this.toStr();
  }

  private static fromJsonObj(jsonObj: unknown): SpanComponentsV4 {
    return new SpanComponentsV4(spanComponentsV4Schema.parse(jsonObj));
  }
}

export function parseParent(
  parent: InvokeFunctionRequest["parent"],
): string | undefined {
  return typeof parent === "string"
    ? parent
    : parent
      ? new SpanComponentsV4({
          object_type:
            parent.object_type === "experiment"
              ? SpanObjectTypeV3.EXPERIMENT
              : parent.object_type === "playground_logs"
                ? SpanObjectTypeV3.PLAYGROUND_LOGS
                : SpanObjectTypeV3.PROJECT_LOGS,
          object_id: parent.object_id,
          ...(parent.row_ids
            ? {
                row_id: parent.row_ids.id,
                span_id: parent.row_ids.span_id,
                root_span_id: parent.row_ids.root_span_id,
              }
            : {
                row_id: undefined,
                span_id: undefined,
                root_span_id: undefined,
              }),
          propagated_event: parent.propagated_event,
        }).toStr()
      : undefined;
}

/**
 * Creates a propagatedEvent for scorer spans by merging the purpose into
 * any existing propagatedEvent from the parent span.
 *
 * @param parent - The parent span export string, or undefined if no parent
 * @returns A propagatedEvent with span_attributes.purpose set to "scorer",
 *          merged with any existing propagatedEvent from the parent
 */
export function makeScorerPropagatedEvent(
  parent: string | undefined,
): Record<string, unknown> {
  const parentPropagatedEvent = parent
    ? (SpanComponentsV4.fromStr(parent).data.propagated_event ?? {})
    : {};
  return mergeDicts(
    { ...parentPropagatedEvent },
    { span_attributes: { purpose: "scorer" } },
  );
}
