import { z } from "zod/v3";
import {
  BraintrustAttachmentReference as braintrustAttachmentReferenceSchema,
  type BraintrustAttachmentReferenceType as BraintrustAttachmentReference,
} from "./generated_types";
import {
  ARRAY_DELETE_FIELD,
  IS_MERGE_FIELD,
  MERGE_PATHS_FIELD,
  OBJECT_DELETE_FIELD,
} from "./util";

export const INGESTION_KEY_ENV_VAR = "BRAINTRUST_INGESTION_KEY";

export interface IngestionEndpoint {
  // The `/ingest` URL without its query string. Requests are sent below it.
  root: string;
  key: string;
}

const INGESTION_KEY_QUERY = /^\?ingestKey=(bt-ik-[A-Za-z0-9]+)$/;

/**
 * Parse an ingestion key URL such as
 * `https://dp.example/base/ingest?ingestKey=bt-ik-...`.
 *
 * Errors never include the provided value, since it contains the key.
 */
export function parseIngestionKeyUrl(value: string): IngestionEndpoint {
  const invalid = (reason: string) =>
    new Error(
      `Invalid Braintrust ingestion key: ${reason}. Expected the full ingestion URL, like https://<data plane>/ingest?ingestKey=<key>.`,
    );

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    // The URL error references the input, so it is not attached as a cause.
    throw invalid("it is not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw invalid("the URL must use http or https");
  }
  if (url.username || url.password) {
    throw invalid("the URL must not contain credentials");
  }
  if (url.hash || value.includes("#")) {
    throw invalid("the URL must not contain a fragment");
  }
  const match = INGESTION_KEY_QUERY.exec(url.search);
  if (!match) {
    throw invalid(
      "the URL must contain exactly one ingestKey query parameter and no other query parameters",
    );
  }
  const pathname = url.pathname.replace(/\/$/, "");
  if (!pathname.endsWith("/ingest")) {
    throw invalid("the URL path must end with /ingest");
  }
  return { root: `${url.origin}${pathname}`, key: match[1] };
}

// Row fields the ingestion endpoint accepts. Everything else (experiment and
// dataset ids, audit fields, scoring controls, comments, ...) is dropped.
const INGESTION_ROW_FIELDS = new Set<string>([
  "id",
  "span_id",
  "root_span_id",
  "span_parents",
  "created",
  "org_id",
  "project_id",
  "log_id",
  "input",
  "output",
  "expected",
  "error",
  "tags",
  "scores",
  "metadata",
  "metrics",
  "context",
  "span_attributes",
  IS_MERGE_FIELD,
  MERGE_PATHS_FIELD,
  ARRAY_DELETE_FIELD,
  OBJECT_DELETE_FIELD,
]);

/**
 * Copy the fields of `row` that the ingestion endpoint accepts. The names of
 * dropped fields are added to `droppedFields`.
 */
export function pickIngestionRowFields(
  row: object,
  droppedFields: Set<string>,
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (INGESTION_ROW_FIELDS.has(key)) {
      picked[key] = value;
    } else if (value !== undefined) {
      droppedFields.add(key);
    }
  }
  return picked;
}

const BRAINTRUST_ATTACHMENT =
  braintrustAttachmentReferenceSchema.shape.type.value;

/**
 * Replace attachment references whose key is in `references` with the
 * reference the ingestion endpoint returned for the upload. A reference mapped
 * to `undefined` failed to upload, in which case this returns false.
 */
export function replaceIngestionAttachmentReferences(
  container: Record<string, unknown> | unknown[],
  references: ReadonlyMap<string, BraintrustAttachmentReference | undefined>,
): boolean {
  for (const [key, value] of Object.entries(container)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const reference = value as Record<string, unknown>;
    if (
      reference.type === BRAINTRUST_ATTACHMENT &&
      typeof reference.key === "string" &&
      references.has(reference.key)
    ) {
      const uploaded = references.get(reference.key);
      if (!uploaded) {
        return false;
      }
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      (container as Record<string, unknown>)[key] = uploaded;
      continue;
    }
    if (!replaceIngestionAttachmentReferences(reference, references)) {
      return false;
    }
  }
  return true;
}

export type IngestionUploadRequest =
  | {
      purpose: "attachment";
      filename: string;
      content_type: string;
    }
  | {
      purpose: "logs3_overflow";
      content_type: "application/json";
    };

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const ingestionUploadGrantSchema = z.object({
  upload_id: z.string().uuid(),
  chunk_bytes: z.number().int().positive(),
  num_chunks: z.number().int().nonnegative(),
  expires_in_ms: z.number().int().positive().max(300_000),
});

export const ingestionUploadChunkSchema = z.object({
  index: z.number().int().nonnegative(),
  size_bytes: z.number().int().nonnegative(),
});

export const ingestionUploadCompleteSchema = z.object({
  reference: z.union([
    braintrustAttachmentReferenceSchema,
    z.object({ type: z.literal("logs3_overflow"), key: z.string().min(1) }),
  ]),
  size_bytes: z.number().int().nonnegative(),
  sha256: sha256Schema,
});

/**
 * Hex SHA-256 digest of `data`, or undefined on platforms without WebCrypto.
 */
export async function sha256Hex(data: Blob): Promise<string | undefined> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    return undefined;
  }
  const digest = await subtle.digest("SHA-256", await data.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
