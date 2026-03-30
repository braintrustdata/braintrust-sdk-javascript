import * as path from "node:path";
import { fileURLToPath } from "node:url";

type Primitive = null | boolean | number | string;
export type Json =
  | Primitive
  | Json[]
  | {
      [key: string]: Json;
    };

type TokenMaps = {
  ids: Map<string, string>;
  runs: Map<string, string>;
  xacts: Map<string, string>;
};

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_SUBSTRING_REGEX =
  /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;
const TIME_KEYS = new Set(["created", "date", "start", "end"]);
const SPAN_ID_KEYS = new Set(["id", "span_id", "root_span_id"]);
const ZERO_NUMBER_KEYS = new Set([
  "avgLogprobs",
  "caller_lineno",
  "duration",
  "time_to_first_token",
]);
const XACT_VERSION_KEYS = new Set([
  "currentVersion",
  "initialVersion",
  "version",
]);
const DYNAMIC_HEADER_KEYS = new Set([
  "cf-ray",
  "openai-processing-ms",
  "openai-project",
  "server-timing",
  "set-cookie",
  "x-gemini-service-tier",
  "x-ratelimit-remaining-requests",
  "x-ratelimit-remaining-tokens",
  "x-ratelimit-reset-requests",
  "x-ratelimit-reset-tokens",
  "x-request-id",
]);
const PROVIDER_ID_KEYS = new Set(["itemId", "responseId", "toolCallId"]);
const PROJECT_ID_KEYS = new Set(["project_id", "projectId"]);
const PROJECT_NAME_KEYS = new Set(["project_name", "projectName"]);
const HELPERS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HELPERS_DIR, "../..").replace(/\\/g, "/");
const STACK_FRAME_REPO_PATH_REGEX =
  /(?:[A-Za-z]:)?[^\s)\n]*braintrust-sdk-javascript(?:[\\/](?:braintrust-sdk-javascript|[^\\/\s)\n]+))?((?:[\\/](?:e2e|js)[^:\s)\n]+)):\d+:\d+/g;
const REPO_PATH_REGEX =
  /(?:[A-Za-z]:)?[^\s)\n]*braintrust-sdk-javascript(?:[\\/](?:braintrust-sdk-javascript|[^\\/\s)\n]+))?((?:[\\/](?:e2e|js)[^:\s)\n]+))/g;
const NODE_INTERNAL_FRAME_REGEX = /node:[^)\n]+:\d+:\d+/g;
const TEMP_SCENARIO_PATH_REGEX =
  /\/e2e\/\.bt-tmp\/[^/\s)]+\/scenarios\/([^/\s)]+)\/?/g;
const TEMP_HELPER_PATH_REGEX = /\/e2e\/\.bt-tmp\/[^/\s)]+\/helpers\/?/g;
const PROVIDER_HELPER_CALLER_REGEX = /^<repo>\/e2e\/helpers\/.+-scenario\.mjs$/;
const ANTHROPIC_MESSAGE_STREAM_PATH_REGEX =
  /([/\\]node_modules[/\\]\.pnpm[/\\]@anthropic-ai\+sdk@[^/\\\s)]+[/\\]node_modules[/\\]@anthropic-ai[/\\]sdk[/\\])(?:src[/\\]lib[/\\]MessageStream\.ts|lib[/\\]MessageStream\.js)/g;
const ANTHROPIC_PNPM_VERSION_REGEX =
  /([/\\]\.pnpm[/\\]@anthropic-ai\+sdk@)[^/\\\s)]+/g;

function isRecord(value: Json | undefined): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeCallerFilename(value: string): string {
  const normalizedValue = value.replace(
    TEMP_SCENARIO_PATH_REGEX,
    "/e2e/scenarios/$1/",
  );
  const helperNormalizedValue = normalizedValue.replace(
    TEMP_HELPER_PATH_REGEX,
    "/e2e/helpers/",
  );
  const e2eIndex = helperNormalizedValue.lastIndexOf("/e2e/");
  if (e2eIndex >= 0) {
    return normalizeModuleSourcePath(
      `<repo>${helperNormalizedValue.slice(e2eIndex)}`,
    );
  }

  return normalizeModuleSourcePath(helperNormalizedValue);
}

function normalizeMockServerUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
      return undefined;
    }

    const suffix = `${url.pathname}${url.search}${url.hash}`;
    return suffix === "/" ? "<mock-server>" : `<mock-server>${suffix}`;
  } catch {
    return undefined;
  }
}

function normalizeStackLikeString(value: string): string {
  let normalized = value.replaceAll("file://", "");
  normalized = normalized.replaceAll(REPO_ROOT, "<repo>");
  normalized = normalized.replace(
    TEMP_SCENARIO_PATH_REGEX,
    "/e2e/scenarios/$1/",
  );
  normalized = normalized.replace(TEMP_HELPER_PATH_REGEX, "/e2e/helpers/");

  normalized = normalized.replace(
    STACK_FRAME_REPO_PATH_REGEX,
    (_, suffix: string) => `<repo>${suffix.replace(/\\/g, "/")}:0:0`,
  );
  normalized = normalized.replace(REPO_PATH_REGEX, (_, suffix: string) => {
    return `<repo>${suffix.replace(/\\/g, "/")}`;
  });
  normalized = normalized.replace(
    /(<repo>(?:\/(?:e2e|js)\/[^:\s)\n]+)):\d+:\d+/g,
    "$1:0:0",
  );
  normalized = normalized.replace(
    NODE_INTERNAL_FRAME_REGEX,
    "node:<internal>:0:0",
  );

  return normalizeModuleSourcePath(normalized);
}

function normalizeModuleSourcePath(value: string): string {
  return value
    .replace(ANTHROPIC_PNPM_VERSION_REGEX, "$1<version>")
    .replace(ANTHROPIC_MESSAGE_STREAM_PATH_REGEX, "$1lib/MessageStream.js");
}

function shouldNormalizeNodeInternalStyleCaller(
  callerFilename: string | undefined,
): boolean {
  if (typeof callerFilename !== "string") {
    return false;
  }

  if (callerFilename.startsWith("node:")) {
    return true;
  }

  return PROVIDER_HELPER_CALLER_REGEX.test(
    normalizeCallerFilename(callerFilename),
  );
}

function normalizeObject(
  value: { [key: string]: Json },
  tokenMaps: TokenMaps,
): Json {
  const callerFilename =
    typeof value.caller_filename === "string"
      ? value.caller_filename
      : undefined;
  const isNodeInternalCaller =
    shouldNormalizeNodeInternalStyleCaller(callerFilename);

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (isNodeInternalCaller) {
        if (key === "caller_filename") {
          return [key, "<node-internal>"];
        }
        if (key === "caller_functionname") {
          return [key, "<node-internal>"];
        }
        if (key === "caller_lineno") {
          return [key, 0];
        }
      }

      return [key, normalizeValue(entry as Json, tokenMaps, key)];
    }),
  );
}

function tokenFor(
  map: Map<string, string>,
  rawValue: string,
  prefix: string,
): string {
  const existing = map.get(rawValue);
  if (existing) {
    return existing;
  }

  const token = `<${prefix}:${map.size + 1}>`;
  map.set(rawValue, token);
  return token;
}

function normalizeValue(
  value: Json,
  tokenMaps: TokenMaps,
  currentKey?: string,
): Json {
  if (Array.isArray(value)) {
    if (currentKey === "span_parents") {
      return value.map((entry) =>
        typeof entry === "string"
          ? tokenFor(tokenMaps.ids, entry, "span")
          : normalizeValue(entry, tokenMaps),
      );
    }

    return value.map((entry) => normalizeValue(entry, tokenMaps));
  }

  if (value && typeof value === "object") {
    return normalizeObject(value, tokenMaps);
  }

  if (typeof value === "number") {
    if (currentKey && ZERO_NUMBER_KEYS.has(currentKey)) {
      return 0;
    }
    if (currentKey && TIME_KEYS.has(currentKey)) {
      return 0;
    }
    return value;
  }

  if (typeof value === "string") {
    value = normalizeStackLikeString(value);

    const normalizedUrl = normalizeMockServerUrl(value);
    if (normalizedUrl) {
      return normalizedUrl;
    }

    if (currentKey === "caller_filename") {
      return normalizeCallerFilename(value);
    }

    if (currentKey === "_xact_id") {
      return tokenFor(tokenMaps.xacts, value, "xact");
    }

    if (currentKey && PROJECT_ID_KEYS.has(currentKey)) {
      if (UUID_REGEX.test(value)) {
        tokenFor(tokenMaps.ids, value, "uuid");
      }
      return "<project_id>";
    }

    if (currentKey && PROJECT_NAME_KEYS.has(currentKey)) {
      let consumedProjectNameToken = false;
      value.replace(UUID_SUBSTRING_REGEX, (match) => {
        tokenFor(tokenMaps.ids, match, "uuid");
        consumedProjectNameToken = true;
        return match;
      });
      if (!consumedProjectNameToken) {
        tokenFor(tokenMaps.ids, `project_name:${value}`, "uuid");
      }
      return "<project_name>";
    }

    if (currentKey && DYNAMIC_HEADER_KEYS.has(currentKey)) {
      return `<${currentKey}>`;
    }

    if (currentKey && XACT_VERSION_KEYS.has(currentKey)) {
      return tokenFor(tokenMaps.xacts, value, "xact");
    }

    if (currentKey === "testRunId") {
      return tokenFor(tokenMaps.runs, value, "run");
    }

    if (currentKey && PROVIDER_ID_KEYS.has(currentKey)) {
      return tokenFor(tokenMaps.ids, value, currentKey);
    }

    if (currentKey && SPAN_ID_KEYS.has(currentKey)) {
      return tokenFor(tokenMaps.ids, value, "span");
    }

    if (currentKey && TIME_KEYS.has(currentKey)) {
      return "<timestamp>";
    }

    if (currentKey === "system_fingerprint") {
      return "<system_fingerprint>";
    }

    if (ISO_DATE_REGEX.test(value)) {
      return "<timestamp>";
    }

    if (value.startsWith("project_id:")) {
      const projectIdValue = value.slice("project_id:".length);
      if (UUID_REGEX.test(projectIdValue)) {
        tokenFor(tokenMaps.ids, projectIdValue, "uuid");
      }
      return "project_id:<project_id>";
    }

    if (value.startsWith("project_name:")) {
      let consumedProjectNameToken = false;
      value.replace(UUID_SUBSTRING_REGEX, (match) => {
        tokenFor(tokenMaps.ids, match, "uuid");
        consumedProjectNameToken = true;
        return match;
      });
      if (!consumedProjectNameToken) {
        tokenFor(tokenMaps.ids, value, "uuid");
      }
      return "project_name:<project_name>";
    }

    const withNormalizedUuids = value.replace(UUID_SUBSTRING_REGEX, (match) =>
      tokenFor(tokenMaps.ids, match, "uuid"),
    );
    if (withNormalizedUuids !== value) {
      return withNormalizedUuids;
    }

    if (UUID_REGEX.test(value)) {
      return tokenFor(tokenMaps.ids, value, "uuid");
    }
  }

  return value;
}

export function normalizeForSnapshot(value: Json): Json {
  return normalizeValue(value, {
    ids: new Map(),
    runs: new Map(),
    xacts: new Map(),
  });
}
