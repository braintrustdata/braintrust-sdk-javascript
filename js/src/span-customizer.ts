import {
  ARRAY_DELETE_FIELD,
  ID_FIELD,
  IS_MERGE_FIELD,
  MERGE_PATHS_FIELD,
  OBJECT_DELETE_FIELD,
  OBJECT_ID_KEYS,
  PARENT_ID_FIELD,
  TRANSACTION_ID_FIELD,
} from "../util/db_fields";
import { isPromiseLike } from "../util/type_util";
import type { SpanCustomizer, SpanExportData } from "./instrumentation/config";

// Configuration can precede platform initialization and must be shared across
// SDK bundles without importing the provider plugin registry into the logger.
const SPAN_CUSTOMIZERS_KEY = Symbol.for("braintrust.spanCustomizers");
const shared: typeof globalThis & {
  [SPAN_CUSTOMIZERS_KEY]?: readonly SpanCustomizer[];
} = globalThis;

const PROTECTED_FIELDS = new Set([
  ID_FIELD,
  "span_id",
  "root_span_id",
  "span_parents",
  "org_id",
  ...OBJECT_ID_KEYS,
  IS_MERGE_FIELD,
  MERGE_PATHS_FIELD,
  PARENT_ID_FIELD,
  OBJECT_DELETE_FIELD,
  ARRAY_DELETE_FIELD,
  TRANSACTION_ID_FIELD,
]);

function isPlainRecord(value: unknown): value is SpanExportData {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// Only protocol values are copied deeply; payloads may contain SDK objects such
// as Attachments that must retain their identity and serialization behavior.
function copyProtocolValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(copyProtocolValue);
  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        copyProtocolValue(item),
      ]),
    );
  }
  return value;
}

function restoreProtocolFields(
  data: SpanExportData,
  protectedFields: SpanExportData,
): SpanExportData {
  const restored: SpanExportData = {};
  for (const key of Object.keys(data)) {
    if (!PROTECTED_FIELDS.has(key)) {
      Object.defineProperty(restored, key, {
        value: data[key],
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  for (const key of Object.keys(protectedFields)) {
    // Give each callback its own protocol arrays/objects, never the snapshot.
    restored[key] = copyProtocolValue(protectedFields[key]);
  }
  return restored;
}

export function setSpanCustomizers(
  customizers: readonly SpanCustomizer[] | undefined,
): void {
  shared[SPAN_CUSTOMIZERS_KEY] = customizers;
}

export function customizeSpanExport(data: SpanExportData): SpanExportData {
  const customizers = shared[SPAN_CUSTOMIZERS_KEY];
  if (!customizers?.length) return data;

  let protectedFields: SpanExportData | undefined;

  for (const customizer of customizers) {
    let candidate = data;
    try {
      if (!customizer.onSpanExport) continue;
      if (!protectedFields) {
        protectedFields = {};
        for (const key of PROTECTED_FIELDS) {
          if (Object.prototype.hasOwnProperty.call(data, key)) {
            protectedFields[key] = copyProtocolValue(data[key]);
          }
        }
      }

      const result: unknown = customizer.onSpanExport(data);
      if (isPromiseLike(result)) {
        // Hooks are synchronous, but accidental async hooks must not leak an
        // unhandled rejection or replace the record with a promise.
        void Promise.resolve(result).catch(() => {});
      } else if (isPlainRecord(result)) {
        candidate = result;
      }
    } catch {
      // Customization must not prevent export or later customizers from running.
    }

    if (protectedFields) {
      try {
        // Always copy: hooks may freeze their input or return a frozen record.
        data = restoreProtocolFields(candidate, protectedFields);
      } catch {
        data = restoreProtocolFields(data, protectedFields);
      }
    }
  }
  return data;
}
