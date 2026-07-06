import * as uuid from "uuid";
import { ParentExperimentIds, ParentProjectLogIds } from "./object";
import { z } from "zod/v3";

function tryMakeUuid(s: string): { bytes: Buffer; isUUID: boolean } {
  try {
    const ret = uuid.parse(s);
    if (ret.length !== 16) {
      throw new Error();
    }
    return { bytes: Buffer.from(ret), isUUID: true };
  } catch (e) {
    return { bytes: Buffer.from(s, "utf-8"), isUUID: false };
  }
}

const ENCODING_VERSION_NUMBER = 1;

const INVALID_ENCODING_ERRMSG =
  "SpanComponents string is not properly encoded. This may be due to a version mismatch between the SDK library used to export the span and the library used to decode it. Please make sure you are using the same SDK version across the board";

export enum SpanObjectTypeV1 {
  EXPERIMENT = 1,
  PROJECT_LOGS = 2,
}

const SpanObjectTypeV1EnumSchema = z.nativeEnum(SpanObjectTypeV1);

export class SpanRowIdsV1 {
  public rowId: string;
  public spanId: string;
  public rootSpanId: string;

  constructor(args: { rowId: string; spanId: string; rootSpanId: string }) {
    this.rowId = args.rowId;
    this.spanId = args.spanId;
    this.rootSpanId = args.rootSpanId;

    if (!this.rowId) {
      throw new Error("rowId must be nonempty string");
    }
    if (!this.spanId) {
      throw new Error("spanId must be nonempty string");
    }
    if (!this.rootSpanId) {
      throw new Error("rootSpanId must be nonempty string");
    }
  }

  public toObject() {
    return {
      rowId: this.rowId,
      spanId: this.spanId,
      rootSpanId: this.rootSpanId,
    };
  }
}

export class SpanComponentsV1 {
  public objectType: SpanObjectTypeV1;
  public objectId: string;
  public rowIds: SpanRowIdsV1 | undefined;

  constructor(args: {
    objectType: SpanObjectTypeV1;
    objectId: string;
    rowIds?: SpanRowIdsV1;
  }) {
    this.objectType = args.objectType;
    this.objectId = args.objectId;
    this.rowIds = args.rowIds;
  }

  public toStr(): string {
    const allBuffers: Array<Buffer> = [];

    const { bytes: rowIdBytes, isUUID: rowIdIsUUID } = this.rowIds
      ? tryMakeUuid(this.rowIds.rowId)
      : { bytes: Buffer.from(""), isUUID: false };

    allBuffers.push(
      Buffer.from([
        ENCODING_VERSION_NUMBER,
        this.objectType,
        this.rowIds ? 1 : 0,
        rowIdIsUUID ? 1 : 0,
      ]),
    );

    const { bytes: objectIdBytes, isUUID: objectIdIsUUID } = tryMakeUuid(
      this.objectId,
    );
    if (!objectIdIsUUID) {
      throw new Error("object_id component must be a valid UUID");
    }
    allBuffers.push(objectIdBytes);

    if (this.rowIds) {
      const { bytes: spanIdBytes, isUUID: spanIdIsUUID } = tryMakeUuid(
        this.rowIds.spanId,
      );
      if (!spanIdIsUUID) {
        throw new Error("span_id component must be a valid UUID");
      }
      const { bytes: rootSpanIdBytes, isUUID: rootSpanIdIsUUID } = tryMakeUuid(
        this.rowIds.rootSpanId,
      );
      if (!rootSpanIdIsUUID) {
        throw new Error("root_span_id component must be a valid UUID");
      }
      allBuffers.push(spanIdBytes, rootSpanIdBytes, rowIdBytes);
    }

    return Buffer.concat(allBuffers).toString("base64");
  }

  public static fromStr(s: string): SpanComponentsV1 {
    try {
      const rawBytes = Buffer.from(s, "base64");
      if (rawBytes[0] !== ENCODING_VERSION_NUMBER) {
        throw new Error();
      }
      const objectType = SpanObjectTypeV1EnumSchema.parse(rawBytes[1]);
      if (![0, 1].includes(rawBytes[2])) {
        throw new Error();
      }
      if (![0, 1].includes(rawBytes[3])) {
        throw new Error();
      }
      const hasRowId = rawBytes[2] == 1;
      const rowIdIsUUID = rawBytes[3] == 1;

      const objectId = uuid.stringify(rawBytes.subarray(4, 20));
      const rowIds = (() => {
        if (!hasRowId) {
          return undefined;
        }
        const spanId = uuid.stringify(rawBytes.subarray(20, 36));
        const rootSpanId = uuid.stringify(rawBytes.subarray(36, 52));
        const rowId = rowIdIsUUID
          ? uuid.stringify(rawBytes.subarray(52))
          : rawBytes.subarray(52).toString("utf-8");
        return new SpanRowIdsV1({ rowId, spanId, rootSpanId });
      })();

      return new SpanComponentsV1({ objectType, objectId, rowIds });
    } catch (e) {
      throw new Error(INVALID_ENCODING_ERRMSG);
    }
  }

  public objectIdFields(): ParentExperimentIds | ParentProjectLogIds {
    switch (this.objectType) {
      case SpanObjectTypeV1.EXPERIMENT:
        return { experiment_id: this.objectId };
      case SpanObjectTypeV1.PROJECT_LOGS:
        return { project_id: this.objectId, log_id: "g" };
      default:
        throw new Error("Impossible");
    }
  }

  public toObject() {
    return {
      objectType: this.objectType,
      objectId: this.objectId,
      rowIds: this.rowIds?.toObject(),
    };
  }
}
