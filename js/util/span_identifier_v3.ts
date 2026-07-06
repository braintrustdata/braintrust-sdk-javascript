import * as uuid from "uuid";
import {
  ParentExperimentIds,
  ParentProjectLogIds,
  ParentPlaygroundLogIds,
} from "./object";
import { SpanComponentsV2 } from "./span_identifier_v2";
import { z } from "zod/v3";
import {
  base64ToUint8Array,
  concatUint8Arrays,
  stringToUint8Array,
  uint8ArrayToBase64,
  uint8ArrayToString,
} from "./bytes";

function tryMakeUuid(
  s: string,
): { bytes: Uint8Array; isUUID: true } | { bytes: undefined; isUUID: false } {
  try {
    const ret = uuid.parse(s);
    if (ret.length !== 16) {
      throw new Error();
    }
    return { bytes: new Uint8Array(ret), isUUID: true };
  } catch {
    return { bytes: undefined, isUUID: false };
  }
}

const ENCODING_VERSION_NUMBER = 3;

const INVALID_ENCODING_ERRMSG = `SpanComponents string is not properly encoded. This library only supports encoding versions up to ${ENCODING_VERSION_NUMBER}. Please make sure the SDK library used to decode the SpanComponents is at least as new as any library used to encode it.`;

export enum SpanObjectTypeV3 {
  EXPERIMENT = 1,
  PROJECT_LOGS = 2,
  PLAYGROUND_LOGS = 3,
}

export const spanObjectTypeV3EnumSchema = z.nativeEnum(SpanObjectTypeV3);

export function spanObjectTypeV3ToTypedString(
  objectType: SpanObjectTypeV3,
): "experiment" | "project_logs" | "playground_logs" {
  switch (objectType) {
    case SpanObjectTypeV3.EXPERIMENT:
      return "experiment";
    case SpanObjectTypeV3.PROJECT_LOGS:
      return "project_logs";
    case SpanObjectTypeV3.PLAYGROUND_LOGS:
      return "playground_logs";
    default:
      const x: never = objectType;
      throw new Error(`Unknown SpanObjectTypeV3: ${x}`);
  }
}

export function spanObjectTypeV3ToString(objectType: SpanObjectTypeV3): string {
  return spanObjectTypeV3ToTypedString(objectType);
}

enum InternalSpanComponentUUIDFields {
  OBJECT_ID = 1,
  ROW_ID = 2,
  SPAN_ID = 3,
  ROOT_SPAN_ID = 4,
}

const internalSpanComponentUUIDFieldsEnumSchema = z.nativeEnum(
  InternalSpanComponentUUIDFields,
);

const _INTERNAL_SPAN_COMPONENT_UUID_FIELDS_ID_TO_NAME: Record<
  InternalSpanComponentUUIDFields,
  string
> = {
  [InternalSpanComponentUUIDFields.OBJECT_ID]: "object_id",
  [InternalSpanComponentUUIDFields.ROW_ID]: "row_id",
  [InternalSpanComponentUUIDFields.SPAN_ID]: "span_id",
  [InternalSpanComponentUUIDFields.ROOT_SPAN_ID]: "root_span_id",
};

export const spanComponentsV3Schema = z
  .object({
    object_type: spanObjectTypeV3EnumSchema,
    // TODO(manu): We should have a more elaborate zod schema for
    // `propagated_event`. This will required zod-ifying the contents of
    // sdk/js/util/object.ts.
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

export type SpanComponentsV3Data = z.infer<typeof spanComponentsV3Schema>;

export class SpanComponentsV3 {
  constructor(public data: SpanComponentsV3Data) {}

  public toStr(): string {
    const jsonObj: Record<string, unknown> = {
      compute_object_metadata_args:
        this.data.compute_object_metadata_args || undefined,
      propagated_event: this.data.propagated_event || undefined,
    };
    const allBuffers: Array<Uint8Array> = [];
    allBuffers.push(
      new Uint8Array([ENCODING_VERSION_NUMBER, this.data.object_type]),
    );

    const uuidEntries: Array<Uint8Array> = [];
    function addUuidField(
      origVal: string,
      fieldId: InternalSpanComponentUUIDFields,
    ) {
      const ret = tryMakeUuid(origVal);
      if (ret.isUUID) {
        uuidEntries.push(
          concatUint8Arrays(new Uint8Array([fieldId]), ret.bytes),
        );
      } else {
        jsonObj[_INTERNAL_SPAN_COMPONENT_UUID_FIELDS_ID_TO_NAME[fieldId]] =
          origVal;
      }
    }
    if (this.data.object_id) {
      addUuidField(
        this.data.object_id,
        InternalSpanComponentUUIDFields.OBJECT_ID,
      );
    }
    if (this.data.row_id) {
      addUuidField(this.data.row_id, InternalSpanComponentUUIDFields.ROW_ID);
    }
    if (this.data.span_id) {
      addUuidField(this.data.span_id, InternalSpanComponentUUIDFields.SPAN_ID);
    }
    if (this.data.root_span_id) {
      addUuidField(
        this.data.root_span_id,
        InternalSpanComponentUUIDFields.ROOT_SPAN_ID,
      );
    }

    if (uuidEntries.length > 255) {
      throw new Error("Impossible: too many UUID entries to encode");
    }
    allBuffers.push(new Uint8Array([uuidEntries.length]));
    allBuffers.push(...uuidEntries);
    if (Object.keys(jsonObj).length > 0) {
      allBuffers.push(stringToUint8Array(JSON.stringify(jsonObj)));
    }
    return uint8ArrayToBase64(concatUint8Arrays(...allBuffers));
  }

  public static fromStr(s: string): SpanComponentsV3 {
    try {
      const rawBytes = base64ToUint8Array(s);
      const jsonObj: Record<string, unknown> = {};
      if (rawBytes[0] < ENCODING_VERSION_NUMBER) {
        const spanComponentsOld = SpanComponentsV2.fromStr(s);
        jsonObj["object_type"] = spanComponentsOld.objectType;
        jsonObj["object_id"] = spanComponentsOld.objectId;
        jsonObj["compute_object_metadata_args"] =
          spanComponentsOld.computeObjectMetadataArgs;
        if (spanComponentsOld.rowIds) {
          jsonObj["row_id"] = spanComponentsOld.rowIds.rowId;
          jsonObj["span_id"] = spanComponentsOld.rowIds.spanId;
          jsonObj["root_span_id"] = spanComponentsOld.rowIds.rootSpanId;
        }
      } else {
        jsonObj["object_type"] = rawBytes[1];
        const numUuidEntries = rawBytes[2];
        let byteOffset = 3;
        for (let i = 0; i < numUuidEntries; ++i) {
          const fieldId = internalSpanComponentUUIDFieldsEnumSchema.parse(
            rawBytes[byteOffset],
          );
          const fieldBytes = rawBytes.subarray(byteOffset + 1, byteOffset + 17);
          byteOffset += 17;
          jsonObj[_INTERNAL_SPAN_COMPONENT_UUID_FIELDS_ID_TO_NAME[fieldId]] =
            uuid.stringify(fieldBytes);
        }
        if (byteOffset < rawBytes.length) {
          const remainingJsonObj = JSON.parse(
            uint8ArrayToString(rawBytes.subarray(byteOffset)),
          );
          Object.assign(jsonObj, remainingJsonObj);
        }
      }
      return SpanComponentsV3.fromJsonObj(jsonObj);
    } catch {
      throw new Error(INVALID_ENCODING_ERRMSG);
    }
  }

  public objectIdFields():
    | ParentExperimentIds
    | ParentProjectLogIds
    | ParentPlaygroundLogIds {
    if (!this.data.object_id) {
      throw new Error(
        "Impossible: cannot invoke `objectIdFields` unless SpanComponentsV3 is initialized with an `object_id`",
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
        throw new Error("Impossible");
    }
  }

  public async export(): Promise<string> {
    return this.toStr();
  }

  private static fromJsonObj(jsonObj: unknown): SpanComponentsV3 {
    return new SpanComponentsV3(spanComponentsV3Schema.parse(jsonObj));
  }
}
