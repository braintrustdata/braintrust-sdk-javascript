#!/usr/bin/env node
// @ts-check
/**
 * Migrate cassette files from the legacy e2e VCR format to the seinfeld format.
 *
 * Usage:
 *   node dev-packages/seinfeld/scripts/migrate-from-legacy.mjs [glob-pattern-or-dir]
 *
 * Example:
 *   # Migrate all cassettes in the e2e scenarios directory
 *   node dev-packages/seinfeld/scripts/migrate-from-legacy.mjs e2e/scenarios
 *
 *   # Migrate a single file
 *   node dev-packages/seinfeld/scripts/migrate-from-legacy.mjs e2e/scenarios/openai-instrumentation/__cassettes__/openai-v6.json
 *
 * Legacy format:
 *   { version, scenario, variantKey, createdAt, entries: [{ key, request: { method, url, headers, bodyEncoding, body, bodyHash }, response: { status, statusText, headers, bodyEncoding, body?, chunks? } }] }
 *
 * Seinfeld format:
 *   { version: 1, meta: { createdAt, seinfeldVersion }, entries: [{ id, matchKey, callIndex, recordedAt, request: { method, url, headers, body: BodyPayload }, response: { status, statusText, headers, body: BodyPayload } }] }
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

const SEINFELD_VERSION = "0.0.0";

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error(
    "Usage: migrate-from-legacy.mjs <path-to-cassette-or-dir> [...more-paths]",
  );
  process.exit(1);
}

let converted = 0;
let skipped = 0;
let errors = 0;

for (const inputPath of args) {
  const stat = await fs.stat(inputPath).catch(() => null);
  if (!stat) {
    console.error(`Not found: ${inputPath}`);
    errors++;
    continue;
  }
  if (stat.isDirectory()) {
    for await (const file of walkCassettes(inputPath)) {
      await migrateFile(file);
    }
  } else {
    await migrateFile(inputPath);
  }
}

console.log(
  `\nDone: ${converted} converted, ${skipped} skipped, ${errors} errors.`,
);
if (errors > 0) process.exit(1);

// ---- migration -----------------------------------------------------------

async function migrateFile(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error(`  SKIP (invalid JSON): ${filePath}`);
    skipped++;
    return;
  }

  if (!isLegacyFormat(parsed)) {
    console.log(`  SKIP (already seinfeld or unknown format): ${filePath}`);
    skipped++;
    return;
  }

  try {
    const converted_data = convertCassette(parsed);
    const output = JSON.stringify(converted_data, null, 2) + "\n";
    await fs.writeFile(filePath, output, "utf8");
    console.log(`  OK: ${filePath}`);
    converted++;
  } catch (err) {
    console.error(
      `  ERROR: ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    errors++;
  }
}

/**
 * Returns true if the file looks like a legacy cassette (has `scenario`/`variantKey` top-level keys).
 * Returns false if it already has seinfeld's `meta` field.
 *
 * @param {unknown} data
 */
function isLegacyFormat(data) {
  if (!data || typeof data !== "object") return false;
  const d = /** @type {Record<string, unknown>} */ (data);
  // Already converted to seinfeld format
  if (d["meta"] !== undefined) return false;
  // Legacy: has `scenario` or `variantKey` or flat `createdAt` at top level
  return (
    typeof d["scenario"] === "string" ||
    typeof d["variantKey"] === "string" ||
    typeof d["createdAt"] === "string"
  );
}

/**
 * Convert a legacy cassette object to seinfeld format.
 *
 * @param {Record<string, unknown>} legacy
 * @returns {Record<string, unknown>}
 */
function convertCassette(legacy) {
  const createdAt =
    typeof legacy["createdAt"] === "string"
      ? legacy["createdAt"]
      : new Date().toISOString();

  const rawEntries = Array.isArray(legacy["entries"]) ? legacy["entries"] : [];

  /** @type {Map<string, number>} */
  const callCounts = new Map();

  const entries = rawEntries.map((raw) => {
    const entry = /** @type {Record<string, unknown>} */ (raw);
    const req = /** @type {Record<string, unknown>} */ (entry["request"] ?? {});
    const res = /** @type {Record<string, unknown>} */ (
      entry["response"] ?? {}
    );

    const method = String(req["method"] ?? "GET").toUpperCase();
    const url = String(req["url"] ?? "");
    const matchKey = computeMatchKey(method, url);
    const callIndex = bumpCallCount(callCounts, matchKey);

    const requestBody = convertBody(
      req["bodyEncoding"],
      req["body"],
      req["chunks"],
    );
    const responseBody = convertBody(
      res["bodyEncoding"],
      res["body"],
      res["chunks"],
    );

    const id = makeEntryId(matchKey, callIndex, requestBody);

    return {
      id,
      matchKey,
      callIndex,
      recordedAt: createdAt,
      request: {
        method,
        url,
        headers: req["headers"] ?? {},
        body: requestBody,
      },
      response: {
        status: res["status"] ?? 200,
        statusText: res["statusText"] ?? "OK",
        headers: res["headers"] ?? {},
        body: responseBody,
      },
    };
  });

  return {
    version: 1,
    meta: { createdAt, seinfeldVersion: SEINFELD_VERSION },
    entries,
  };
}

/**
 * Convert legacy bodyEncoding/body/chunks to a seinfeld BodyPayload.
 *
 * @param {unknown} encoding
 * @param {unknown} body
 * @param {unknown} chunks
 * @returns {Record<string, unknown>}
 */
function convertBody(encoding, body, chunks) {
  if (!encoding || encoding === "empty" || (body == null && !chunks)) {
    return { kind: "empty" };
  }
  switch (encoding) {
    case "json": {
      if (body == null) return { kind: "empty" };
      return { kind: "json", value: body };
    }
    case "utf8":
    case "text": {
      return { kind: "text", value: String(body ?? "") };
    }
    case "base64": {
      return { kind: "base64", value: String(body ?? "") };
    }
    case "sse-chunks": {
      // Legacy SSE: chunks is an array of { data: base64, encoding: 'base64' }.
      // Seinfeld SSE: chunks is an array of raw UTF-8 strings.
      const rawChunks = Array.isArray(chunks)
        ? chunks
        : Array.isArray(body)
          ? body
          : [];
      return {
        kind: "sse",
        chunks: rawChunks.map((c) => {
          if (typeof c === "string") return c;
          const obj = /** @type {Record<string, unknown>} */ (c);
          if (obj["encoding"] === "base64" && typeof obj["data"] === "string") {
            return Buffer.from(String(obj["data"]), "base64").toString("utf8");
          }
          return String(obj["data"] ?? c);
        }),
      };
    }
    default:
      // Unknown encoding — fall back to empty
      return { kind: "empty" };
  }
}

/**
 * Compute seinfeld matchKey: "METHOD host/path".
 *
 * @param {string} method
 * @param {string} url
 */
function computeMatchKey(method, url) {
  try {
    const parsed = new URL(url);
    return `${method.toUpperCase()} ${parsed.host}${parsed.pathname}`;
  } catch {
    return `${method.toUpperCase()} ${url}`;
  }
}

/**
 * Bump and return the current call count for a matchKey.
 *
 * @param {Map<string, number>} counts
 * @param {string} key
 */
function bumpCallCount(counts, key) {
  const current = counts.get(key) ?? 0;
  counts.set(key, current + 1);
  return current;
}

/**
 * Compute a seinfeld entry ID: sha256(matchKey + '\n' + callIndex + '\n' + JSON.stringify(body)).slice(0, 16)
 *
 * @param {string} matchKey
 * @param {number} callIndex
 * @param {unknown} body
 */
function makeEntryId(matchKey, callIndex, body) {
  const raw = `${matchKey}\n${callIndex}\n${JSON.stringify(body)}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

/**
 * Recursively walk a directory and yield paths matching *.json inside __cassettes__ dirs.
 *
 * @param {string} dir
 * @returns {AsyncGenerator<string>}
 */
async function* walkCassettes(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkCassettes(fullPath);
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".json") &&
      path.basename(path.dirname(fullPath)) === "__cassettes__"
    ) {
      yield fullPath;
    }
  }
}
