import { isObject } from "../../../util/index";
import { processInputAttachments } from "../../wrappers/attachment-utils";

const TOKEN_NAME_MAP: Record<string, string> = {
  promptTokens: "prompt_tokens",
  inputTokens: "prompt_tokens",
  completionTokens: "completion_tokens",
  outputTokens: "completion_tokens",
  totalTokens: "tokens",
  prompt_tokens: "prompt_tokens",
  input_tokens: "prompt_tokens",
  completion_tokens: "completion_tokens",
  output_tokens: "completion_tokens",
  total_tokens: "tokens",
};

const PROMPT_TOKEN_DETAIL_NAME_MAP: Record<string, string> = {
  cachedTokens: "prompt_cached_tokens",
  cached_tokens: "prompt_cached_tokens",
  cacheCreationTokens: "prompt_cache_creation_tokens",
  cache_creation_tokens: "prompt_cache_creation_tokens",
  cacheCreation5mTokens: "prompt_cache_creation_5m_tokens",
  cache_creation_5m_tokens: "prompt_cache_creation_5m_tokens",
  cacheCreation1hTokens: "prompt_cache_creation_1h_tokens",
  cache_creation_1h_tokens: "prompt_cache_creation_1h_tokens",
  audioTokens: "prompt_audio_tokens",
  audio_tokens: "prompt_audio_tokens",
};

const COMPLETION_TOKEN_DETAIL_NAME_MAP: Record<string, string> = {
  reasoningTokens: "completion_reasoning_tokens",
  reasoning_tokens: "completion_reasoning_tokens",
  audioTokens: "completion_audio_tokens",
  audio_tokens: "completion_audio_tokens",
  imageTokens: "completion_image_tokens",
  image_tokens: "completion_image_tokens",
};

const TOKEN_DETAIL_NAME_MAP: Record<string, Record<string, string>> = {
  promptTokensDetails: PROMPT_TOKEN_DETAIL_NAME_MAP,
  inputTokensDetails: PROMPT_TOKEN_DETAIL_NAME_MAP,
  prompt_tokens_details: PROMPT_TOKEN_DETAIL_NAME_MAP,
  input_tokens_details: PROMPT_TOKEN_DETAIL_NAME_MAP,
  completionTokensDetails: COMPLETION_TOKEN_DETAIL_NAME_MAP,
  outputTokensDetails: COMPLETION_TOKEN_DETAIL_NAME_MAP,
  completion_tokens_details: COMPLETION_TOKEN_DETAIL_NAME_MAP,
  output_tokens_details: COMPLETION_TOKEN_DETAIL_NAME_MAP,
};

const MISTRAL_REQUEST_METADATA_MAP: Record<string, string> = {
  agentId: "agent_id",
  agent_id: "agent_id",
  encodingFormat: "encoding_format",
  encoding_format: "encoding_format",
  frequencyPenalty: "frequency_penalty",
  frequency_penalty: "frequency_penalty",
  maxTokens: "max_tokens",
  max_tokens: "max_tokens",
  model: "model",
  n: "n",
  presencePenalty: "presence_penalty",
  presence_penalty: "presence_penalty",
  randomSeed: "random_seed",
  random_seed: "random_seed",
  reasoningEffort: "reasoning_effort",
  reasoning_effort: "reasoning_effort",
  responseFormat: "response_format",
  response_format: "response_format",
  safePrompt: "safe_prompt",
  safe_prompt: "safe_prompt",
  stream: "stream",
  stop: "stop",
  temperature: "temperature",
  topP: "top_p",
  top_p: "top_p",
};

const MISTRAL_RESPONSE_METADATA_MAP: Record<string, string> = {
  agentId: "agent_id",
  agent_id: "agent_id",
  created: "created",
  id: "id",
  model: "model",
  object: "object",
};

function pickMappedMetadata(
  metadata: Record<string, unknown> | undefined,
  mapping: Readonly<Record<string, string>>,
): Record<string, unknown> {
  if (!metadata) {
    return {};
  }

  const picked: Record<string, unknown> = {};
  for (const [source, canonical] of Object.entries(mapping)) {
    const value = metadata[source];
    if (value !== undefined) {
      picked[canonical] = value;
    }
  }
  return picked;
}

export function extractMistralRequestMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const picked = pickMappedMetadata(metadata, MISTRAL_REQUEST_METADATA_MAP);
  if (!metadata) {
    return picked;
  }

  if (Array.isArray(metadata.tools)) {
    const tools = metadata.tools.flatMap((tool) => {
      if (!isObject(tool)) {
        return [];
      }
      if (isObject(tool.function)) {
        const fn = tool.function;
        if (typeof fn.name !== "string" || fn.name.length === 0) {
          return [];
        }
        return [
          {
            type: "function",
            function: {
              name: fn.name,
              ...(typeof fn.description === "string"
                ? { description: fn.description }
                : {}),
              ...(isObject(fn.parameters) ? { parameters: fn.parameters } : {}),
              ...(typeof fn.strict === "boolean" ? { strict: fn.strict } : {}),
            },
          },
        ];
      }

      const type = tool.type;
      if (
        type !== "web_search" &&
        type !== "web_search_premium" &&
        type !== "code_interpreter" &&
        type !== "image_generation" &&
        type !== "document_library" &&
        type !== "connector"
      ) {
        return [];
      }

      const normalized: Record<string, unknown> = { type };
      const rawConfiguration =
        tool.tool_configuration ?? tool.toolConfiguration;
      if (isObject(rawConfiguration)) {
        const configuration: Record<string, unknown> = {};
        for (const key of ["exclude", "include"] as const) {
          const value = rawConfiguration[key];
          if (
            Array.isArray(value) &&
            value.every((entry) => typeof entry === "string")
          ) {
            configuration[key] = value;
          }
        }
        const requiresConfirmation =
          rawConfiguration.requires_confirmation ??
          rawConfiguration.requiresConfirmation;
        if (
          Array.isArray(requiresConfirmation) &&
          requiresConfirmation.every((entry) => typeof entry === "string")
        ) {
          configuration.requires_confirmation = requiresConfirmation;
        }
        if (Object.keys(configuration).length > 0) {
          normalized.tool_configuration = configuration;
        }
      }
      const libraryIds = tool.library_ids ?? tool.libraryIds;
      if (
        type === "document_library" &&
        Array.isArray(libraryIds) &&
        libraryIds.every((entry) => typeof entry === "string")
      ) {
        normalized.library_ids = libraryIds;
      }
      const connectorId = tool.connector_id ?? tool.connectorId;
      if (type === "connector" && typeof connectorId === "string") {
        normalized.connector_id = connectorId;
      }
      return [normalized];
    });
    if (tools.length > 0) {
      picked.tools = tools;
    }
  }

  const rawToolChoice = metadata.tool_choice ?? metadata.toolChoice;
  if (
    rawToolChoice === "auto" ||
    rawToolChoice === "none" ||
    rawToolChoice === "required"
  ) {
    picked.tool_choice = rawToolChoice;
  } else if (rawToolChoice === "any") {
    picked.tool_choice = "required";
  } else if (
    isObject(rawToolChoice) &&
    isObject(rawToolChoice.function) &&
    typeof rawToolChoice.function.name === "string" &&
    rawToolChoice.function.name.length > 0
  ) {
    picked.tool_choice = {
      type: "function",
      function: { name: rawToolChoice.function.name },
    };
  }

  const parallelToolCalls =
    metadata.parallel_tool_calls ?? metadata.parallelToolCalls;
  if (typeof parallelToolCalls === "boolean") {
    picked.parallel_tool_calls = parallelToolCalls;
  }
  const maxToolCalls = metadata.max_tool_calls ?? metadata.maxToolCalls;
  if (typeof maxToolCalls === "number" && Number.isFinite(maxToolCalls)) {
    picked.max_tool_calls = maxToolCalls;
  }

  return picked;
}

function normalizeMistralToolCall(
  value: unknown,
): Record<string, unknown> | undefined {
  if (
    !isObject(value) ||
    typeof value.id !== "string" ||
    !isObject(value.function) ||
    typeof value.function.name !== "string" ||
    typeof value.function.arguments !== "string"
  ) {
    return undefined;
  }

  return {
    id: value.id,
    type: typeof value.type === "string" ? value.type : "function",
    function: {
      name: value.function.name,
      arguments: value.function.arguments,
    },
  };
}

function normalizeMistralChatMessage(
  value: unknown,
  defaultRole?: "assistant",
): Record<string, unknown> | undefined {
  if (!isObject(value)) {
    return undefined;
  }

  const role = typeof value.role === "string" ? value.role : defaultRole;
  const toolCallId = value.tool_call_id ?? value.toolCallId;
  const rawToolCalls = value.tool_calls ?? value.toolCalls;
  const toolCalls = Array.isArray(rawToolCalls)
    ? rawToolCalls
        .map(normalizeMistralToolCall)
        .filter(
          (toolCall): toolCall is Record<string, unknown> =>
            toolCall !== undefined,
        )
    : [];

  const message: Record<string, unknown> = {};
  if (role) {
    message.role = role;
  }
  if (Object.hasOwn(value, "content")) {
    message.content = value.content;
  } else if (defaultRole) {
    message.content = null;
  }
  if (typeof value.name === "string") {
    message.name = value.name;
  }
  if (typeof toolCallId === "string") {
    message.tool_call_id = toolCallId;
  }
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }
  return message;
}

export function normalizeMistralChatMessages(messages: unknown): unknown {
  if (!Array.isArray(messages)) {
    return messages;
  }

  return messages.map(
    (message) => normalizeMistralChatMessage(message) ?? message,
  );
}

export function normalizeMistralChatChoices(
  choices: unknown,
): Record<string, unknown>[] | undefined {
  if (!Array.isArray(choices) || choices.length === 0) {
    return undefined;
  }

  const normalized: Record<string, unknown>[] = [];
  for (const [position, choice] of choices.entries()) {
    if (!isObject(choice)) {
      return undefined;
    }
    const message = normalizeMistralChatMessage(choice.message, "assistant");
    if (!message) {
      return undefined;
    }
    const finishReason = choice.finish_reason ?? choice.finishReason;
    normalized.push({
      index:
        typeof choice.index === "number" && choice.index >= 0
          ? choice.index
          : position,
      ...(typeof finishReason === "string" || finishReason === null
        ? { finish_reason: finishReason }
        : {}),
      message,
      ...(Object.hasOwn(choice, "logprobs")
        ? { logprobs: choice.logprobs }
        : {}),
    });
  }

  return normalized;
}

export function extractMistralChatInput(
  params: Record<string, unknown>,
  options: { processAttachments?: boolean } = {},
): {
  input: unknown;
  metadata: Record<string, unknown>;
} {
  const { messages, ...rawMetadata } = params;
  const normalizedMessages = normalizeMistralChatMessages(messages);
  return {
    input:
      options.processAttachments === false
        ? normalizedMessages
        : processInputAttachments(normalizedMessages),
    metadata: {
      ...extractMistralRequestMetadata(rawMetadata),
      provider: "mistral",
    },
  };
}

export function extractMistralResponseMetadata(
  result: unknown,
): Record<string, unknown> | undefined {
  if (!isObject(result)) {
    return undefined;
  }

  const { choices: _choices, usage: _usage, data: _data, ...metadata } = result;
  const picked = pickMappedMetadata(metadata, MISTRAL_RESPONSE_METADATA_MAP);
  return Object.keys(picked).length > 0 ? picked : undefined;
}

export function parseMistralMetricsFromUsage(
  usage: unknown,
): Record<string, number> {
  if (!isObject(usage)) {
    return {};
  }

  const metrics: Record<string, number> = {};
  for (const [name, value] of Object.entries(usage)) {
    const metricName = Object.hasOwn(TOKEN_NAME_MAP, name)
      ? TOKEN_NAME_MAP[name]
      : undefined;
    if (metricName) {
      if (
        typeof value === "number" &&
        Number.isFinite(value) &&
        Number.isInteger(value) &&
        value >= 0
      ) {
        metrics[metricName] = value;
      }
      continue;
    }
    if (!isObject(value)) {
      continue;
    }

    const detailNames = Object.hasOwn(TOKEN_DETAIL_NAME_MAP, name)
      ? TOKEN_DETAIL_NAME_MAP[name]
      : undefined;
    if (!detailNames) {
      continue;
    }
    for (const [nestedName, nestedValue] of Object.entries(value)) {
      const metricName = Object.hasOwn(detailNames, nestedName)
        ? detailNames[nestedName]
        : undefined;
      if (
        metricName &&
        typeof nestedValue === "number" &&
        Number.isFinite(nestedValue) &&
        Number.isInteger(nestedValue) &&
        nestedValue >= 0
      ) {
        metrics[metricName] = nestedValue;
      }
    }
  }
  if (
    metrics.tokens === undefined &&
    Number.isSafeInteger(metrics.prompt_tokens) &&
    Number.isSafeInteger(metrics.completion_tokens)
  ) {
    const tokens = metrics.prompt_tokens + metrics.completion_tokens;
    if (Number.isSafeInteger(tokens)) {
      metrics.tokens = tokens;
    }
  }
  return metrics;
}
