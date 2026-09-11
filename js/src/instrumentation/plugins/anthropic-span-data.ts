import { Attachment, type BraintrustState } from "../../logger";
import {
  finalizeAnthropicTokens,
  toNumericMetrics,
} from "../../wrappers/anthropic-tokens-util";
import type {
  AnthropicBase64Source,
  AnthropicCreateParams,
  AnthropicInputMessage,
  AnthropicMessage,
  AnthropicUsage,
} from "../../vendor-sdk-types/anthropic";
import { isObject } from "../../../util/index";

const ANTHROPIC_REQUEST_METADATA_FIELDS = [
  "context_management",
  "inference_geo",
  "max_tokens",
  "model",
  "output_config",
  "service_tier",
  "speed",
  "stop_sequences",
  "stream",
  "temperature",
  "thinking",
  "top_k",
  "top_p",
] as const;

const ANTHROPIC_BUILTIN_TOOL_COMMON_FIELDS = [
  "name",
  "type",
  "allowed_callers",
  "cache_control",
  "defer_loading",
  "strict",
] as const;

const ANTHROPIC_BUILTIN_TOOL_FIELDS_BY_FAMILY = [
  [
    "advisor_",
    [
      ...ANTHROPIC_BUILTIN_TOOL_COMMON_FIELDS,
      "caching",
      "max_tokens",
      "max_uses",
      "model",
    ],
  ],
  ["bash_", [...ANTHROPIC_BUILTIN_TOOL_COMMON_FIELDS, "input_examples"]],
  ["code_execution_", ANTHROPIC_BUILTIN_TOOL_COMMON_FIELDS],
  [
    "computer_",
    [
      ...ANTHROPIC_BUILTIN_TOOL_COMMON_FIELDS,
      "display_height_px",
      "display_number",
      "display_width_px",
      "enable_zoom",
      "input_examples",
    ],
  ],
  ["memory_", [...ANTHROPIC_BUILTIN_TOOL_COMMON_FIELDS, "input_examples"]],
  [
    "text_editor_",
    [
      ...ANTHROPIC_BUILTIN_TOOL_COMMON_FIELDS,
      "input_examples",
      "max_characters",
    ],
  ],
  ["tool_search_", ANTHROPIC_BUILTIN_TOOL_COMMON_FIELDS],
  [
    "web_fetch_",
    [
      ...ANTHROPIC_BUILTIN_TOOL_COMMON_FIELDS,
      "allowed_domains",
      "blocked_domains",
      "citations",
      "max_content_tokens",
      "max_uses",
      "response_inclusion",
      "use_cache",
    ],
  ],
  [
    "web_search_",
    [
      ...ANTHROPIC_BUILTIN_TOOL_COMMON_FIELDS,
      "allowed_domains",
      "blocked_domains",
      "max_uses",
      "response_inclusion",
      "user_location",
    ],
  ],
] as const;

const ANTHROPIC_MCP_TOOLSET_FIELDS = [
  "mcp_server_name",
  "type",
  "cache_control",
  "configs",
  "default_config",
] as const;

export function extractAnthropicInput(
  params: AnthropicCreateParams,
  options?: {
    attachmentKey?: (index: number) => string;
    state?: BraintrustState;
  },
): {
  input: unknown;
  metadata: Record<string, unknown>;
} {
  const input = coalesceInput(params.messages || [], params.system);
  return {
    input: processAttachmentsInInput(input, options),
    metadata: extractAnthropicInputMetadata(params),
  };
}

export function extractAnthropicInputMetadata(
  params: AnthropicCreateParams,
  options?: { includeTools?: boolean },
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  for (const field of ANTHROPIC_REQUEST_METADATA_FIELDS) {
    if (params[field] !== undefined) {
      metadata[field] = params[field];
    }
  }
  if (options?.includeTools !== false) {
    const tools = normalizeAnthropicTools(params.tools);
    if (tools) {
      metadata.tools = tools;
    }
  }
  const toolChoice = normalizeAnthropicToolChoice(params.tool_choice);
  if (toolChoice?.choice !== undefined) {
    metadata.tool_choice = toolChoice.choice;
  }
  if (toolChoice?.parallelToolCalls !== undefined) {
    metadata.parallel_tool_calls = toolChoice.parallelToolCalls;
  }
  return { ...metadata, provider: "anthropic" };
}

function normalizeAnthropicTools(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const tools: unknown[] = [];
  for (const tool of value) {
    if (!isObject(tool)) {
      continue;
    }
    try {
      const type = Reflect.get(tool, "type");
      const name = Reflect.get(tool, "name");
      const inputSchema = Reflect.get(tool, "input_schema");
      if (
        (type === undefined || type === null || type === "custom") &&
        typeof name === "string" &&
        isObject(inputSchema)
      ) {
        const description = Reflect.get(tool, "description");
        const strict = Reflect.get(tool, "strict");
        tools.push({
          type: "function",
          function: {
            name,
            ...(typeof description === "string" ? { description } : {}),
            parameters: inputSchema,
            ...(typeof strict === "boolean" ? { strict } : {}),
          },
        });
        continue;
      }
      if (typeof type !== "string") {
        continue;
      }
      let fields: readonly string[];
      if (type === "mcp_toolset") {
        fields = ANTHROPIC_MCP_TOOLSET_FIELDS;
      } else {
        fields = ANTHROPIC_BUILTIN_TOOL_FIELDS_BY_FAMILY.find(([prefix]) =>
          type.startsWith(prefix),
        )?.[1] ?? ["name", "type"];
      }
      const normalized: Record<string, unknown> = {};
      for (const field of fields) {
        const fieldValue = Reflect.get(tool, field);
        if (fieldValue !== undefined) {
          normalized[field] = fieldValue;
        }
      }
      tools.push(normalized);
    } catch {
      // A hostile tool object must not prevent tracing the rest of the input.
    }
  }
  return tools.length > 0 ? tools : undefined;
}

function normalizeAnthropicToolChoice(value: unknown):
  | {
      choice?: unknown;
      parallelToolCalls?: boolean;
    }
  | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  try {
    const type = Reflect.get(value, "type");
    const name = Reflect.get(value, "name");
    const disableParallelToolUse = Reflect.get(
      value,
      "disable_parallel_tool_use",
    );
    const parallelToolCalls =
      typeof disableParallelToolUse === "boolean"
        ? !disableParallelToolUse
        : undefined;
    if (type === "auto" || type === "none") {
      return { choice: type, parallelToolCalls };
    }
    if (type === "any") {
      return { choice: "required", parallelToolCalls };
    }
    if (type === "tool" && typeof name === "string") {
      return {
        choice: { type: "function", function: { name } },
        parallelToolCalls,
      };
    }
    return parallelToolCalls === undefined ? undefined : { parallelToolCalls };
  } catch {
    return undefined;
  }
}

export function extractAnthropicOutput(
  message: AnthropicMessage | undefined,
): { role: string; content: AnthropicMessage["content"] } | null {
  return message ? { role: message.role, content: message.content } : null;
}

export function extractAnthropicOutputMetadata(
  message:
    | Partial<Pick<AnthropicMessage, "model" | "stop_reason" | "stop_sequence">>
    | undefined,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  for (const field of ["model", "stop_reason", "stop_sequence"] as const) {
    if (message?.[field] !== undefined) {
      metadata[field] = message[field];
    }
  }
  return metadata;
}

export function extractAnthropicMetrics(
  message: AnthropicMessage | undefined,
): Record<string, number> {
  const metrics = parseMetricsFromUsage(message?.usage);
  const finalized = finalizeAnthropicTokens(metrics);
  if (metrics.prompt_tokens === undefined) {
    delete finalized.prompt_tokens;
  }
  if (
    metrics.prompt_tokens === undefined ||
    metrics.completion_tokens === undefined
  ) {
    delete finalized.tokens;
  }
  return toNumericMetrics(finalized);
}

/** Map Anthropic usage fields to Braintrust's canonical metric names. */
export function parseMetricsFromUsage(
  usage: AnthropicUsage | undefined,
): Record<string, number> {
  if (!usage) {
    return {};
  }

  const metrics: Record<string, number> = {};
  for (const [source, target] of [
    ["input_tokens", "prompt_tokens"],
    ["output_tokens", "completion_tokens"],
    ["cache_read_input_tokens", "prompt_cached_tokens"],
    ["cache_creation_input_tokens", "prompt_cache_creation_tokens"],
  ] as const) {
    const value = usage[source];
    if (
      typeof value === "number" &&
      Number.isFinite(value) &&
      Number.isInteger(value) &&
      value >= 0
    ) {
      metrics[target] = value;
    }
  }

  if (isObject(usage.cache_creation)) {
    for (const [source, target] of [
      ["ephemeral_5m_input_tokens", "prompt_cache_creation_5m_tokens"],
      ["ephemeral_1h_input_tokens", "prompt_cache_creation_1h_tokens"],
    ] as const) {
      const value = usage.cache_creation[source];
      if (
        typeof value === "number" &&
        Number.isFinite(value) &&
        Number.isInteger(value) &&
        value >= 0
      ) {
        metrics[target] = value;
      }
    }
  }

  const thinkingTokens = isObject(usage.output_tokens_details)
    ? usage.output_tokens_details.thinking_tokens
    : undefined;
  if (
    typeof thinkingTokens === "number" &&
    Number.isFinite(thinkingTokens) &&
    Number.isInteger(thinkingTokens) &&
    thinkingTokens >= 0
  ) {
    metrics.completion_reasoning_tokens = thinkingTokens;
  }

  return metrics;
}

function isAnthropicBase64ContentBlock(
  input: Record<string, unknown>,
): input is Record<string, unknown> & {
  source: AnthropicBase64Source;
  type: "image" | "document";
} {
  return (
    (input.type === "image" || input.type === "document") &&
    isObject(input.source) &&
    input.source.type === "base64"
  );
}

function convertBase64ToAttachment(
  source: AnthropicBase64Source,
  contentType: "image" | "document",
  key: string | undefined,
  state: BraintrustState | undefined,
): Record<string, unknown> {
  const mediaType =
    typeof source.media_type === "string" ? source.media_type : "image/png";
  if (typeof source.data !== "string" || !source.data) {
    return { ...source };
  }

  const binaryString = atob(source.data);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  const extension = mediaType.split("/")[1] || "bin";
  const prefix = contentType === "document" ? "document" : "image";
  const attachment = new Attachment({
    data: new Blob([bytes], { type: mediaType }),
    filename: `${prefix}.${extension}`,
    contentType: mediaType,
    state,
  });
  if (key) {
    // Batch retries must write the same opaque reference and upload identity.
    attachment.reference.key = key;
  }
  return {
    ...source,
    data: attachment,
  };
}

/** Convert Anthropic base64 image and document blocks to attachments. */
export function processAttachmentsInInput(
  input: unknown,
  options?: {
    attachmentKey?: (index: number) => string;
    state?: BraintrustState;
  },
): unknown {
  let attachmentIndex = 0;
  function walk(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map(walk);
    }
    if (!isObject(value)) {
      return value;
    }
    if (isAnthropicBase64ContentBlock(value)) {
      const key =
        typeof value.source.data === "string" && value.source.data
          ? options?.attachmentKey?.(attachmentIndex++)
          : undefined;
      try {
        return {
          ...value,
          source: convertBase64ToAttachment(
            value.source,
            value.type,
            key,
            options?.state,
          ),
        };
      } catch {
        // Preserve the provider-native block when attachment conversion fails.
        return value;
      }
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, walk(entry)]),
    );
  }
  return walk(input);
}

/** Normalize Anthropic's separate system prompt into the message sequence. */
export function coalesceInput(
  messages: AnthropicInputMessage[],
  system: AnthropicCreateParams["system"],
): AnthropicInputMessage[] {
  const input = (messages || []).slice();
  if (system) {
    input.unshift({ role: "system", content: system });
  }
  return input;
}
