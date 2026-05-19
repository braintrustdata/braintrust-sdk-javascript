import { z } from "zod";

/**
 * Zod schema for cassette format version 1.
 *
 * Cassette files carry a `version` field so that: (a) load-time validation
 * fails loudly on corrupt files rather than silently at match time, and
 * (b) a future breaking change can introduce v2 while the library still reads
 * older cassettes without ambiguity. See `format/index.ts` for the dispatch
 * logic and the rule for when to bump the version.
 */

export const CURRENT_FORMAT_VERSION = 1 as const;

const bodyPayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("empty") }),
  z.object({ kind: z.literal("json"), value: z.unknown() }),
  z.object({ kind: z.literal("text"), value: z.string() }),
  z.object({
    kind: z.literal("base64"),
    value: z.string(),
    contentType: z.string().optional(),
  }),
  z.object({
    kind: z.literal("sse"),
    chunks: z.array(z.string()),
  }),
  z.object({
    kind: z.literal("binary"),
    path: z.string().min(1),
    contentType: z.string().optional(),
    sha256: z.string().length(64),
  }),
]);

const recordedRequestSchema = z.object({
  method: z.string().min(1),
  url: z.string().url(),
  headers: z.record(z.string()),
  body: bodyPayloadSchema,
});

const recordedResponseSchema = z.object({
  status: z.number().int().min(100).max(599),
  statusText: z.string().optional(),
  headers: z.record(z.string()),
  body: bodyPayloadSchema,
});

const cassetteEntrySchema = z
  .object({
    id: z.string().min(1),
    matchKey: z.string().min(1),
    callIndex: z.number().int().min(0),
    recordedAt: z.string(),
    request: recordedRequestSchema,
    response: recordedResponseSchema,
  })
  .passthrough();

const cassetteMetaSchema = z
  .object({
    createdAt: z.string(),
    seinfeldVersion: z.string(),
  })
  .passthrough();

export const cassetteSchema = z.object({
  version: z.literal(CURRENT_FORMAT_VERSION),
  meta: cassetteMetaSchema.optional(),
  entries: z.array(cassetteEntrySchema),
});
