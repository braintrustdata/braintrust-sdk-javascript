import { _internalCreateAttachment, Attachment } from "../../logger";
import type { GoogleGenAIUsageMetadata } from "../../vendor-sdk-types/google-genai";
import { isObject } from "../../../util/index";

// Explicit metadata allowlist for GenerateContentConfig. Transport settings,
// abort signals, billing labels, and arbitrary extension fields are omitted.
const GENERATION_CONFIG_FIELDS = [
  "audioTimestamp",
  "cachedContent",
  "candidateCount",
  "frequencyPenalty",
  "imageConfig",
  "logprobs",
  "maxOutputTokens",
  "mediaResolution",
  "presencePenalty",
  "responseJsonSchema",
  "responseLogprobs",
  "responseMimeType",
  "responseModalities",
  "responseSchema",
  "safetySettings",
  "seed",
  "serviceTier",
  "speechConfig",
  "stopSequences",
  "temperature",
  "thinkingConfig",
  "toolConfig",
  "tools",
  "topK",
  "topP",
] as const;

const BUILT_IN_TOOL_FIELDS = [
  "codeExecution",
  "computerUse",
  "enterpriseWebSearch",
  "fileSearch",
  "googleMaps",
  "googleSearch",
  "googleSearchRetrieval",
  "mcpServers",
  "parallelAiSearch",
  "retrieval",
  "urlContext",
] as const;

// The GenerateContent response also exposes transport-only fields such as
// sdkHttpResponse. Keep output capture limited to documented model results.
const GENERATE_CONTENT_RESPONSE_FIELDS = [
  "automaticFunctionCallingHistory",
  "candidates",
  "createTime",
  "modelVersion",
  "promptFeedback",
  "responseId",
  "usageMetadata",
] as const;

function read(value: unknown, key: PropertyKey): unknown {
  if (!isObject(value)) {
    return undefined;
  }
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

function resolveGoogleGenAIObject(value: unknown): unknown {
  const toJSON = read(value, "toJSON");
  if (typeof toJSON !== "function") {
    return value;
  }
  try {
    return Reflect.apply(toJSON, value, []);
  } catch {
    return undefined;
  }
}

function selectGoogleGenAIGenerationConfig(
  value: unknown,
): Record<string, unknown> {
  const config = resolveGoogleGenAIObject(value);
  const selected: Record<string, unknown> = {};
  for (const key of GENERATION_CONFIG_FIELDS) {
    const entry = read(config, key);
    if (entry !== undefined) {
      selected[key] = serializeGoogleGenAIValue(entry);
    }
  }
  return selected;
}

export function extractGoogleGenAIGenerationMetadata(
  configValue: unknown,
  model?: string,
): Record<string, unknown> {
  const {
    tools: providerTools,
    toolConfig,
    ...config
  } = selectGoogleGenAIGenerationConfig(configValue);
  const tools = serializeGoogleGenAITools(providerTools);
  const toolChoice = normalizeGoogleGenAIToolChoice(toolConfig);

  return {
    ...config,
    ...(tools.length > 0 ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(model ? { model } : {}),
    provider: "google",
  };
}

export function extractGoogleGenAISystemInstruction(config: unknown): unknown {
  return read(resolveGoogleGenAIObject(config), "systemInstruction");
}

export function serializeGoogleGenAIRequestContents(
  contents: unknown,
  systemInstruction: unknown,
  options: GoogleGenAISerializationOptions = {},
): unknown {
  const state = createGoogleGenAISerializationState(options);
  const serializedContents = serializeGoogleGenAIContentsInternal(
    contents,
    state,
  );
  if (systemInstruction === undefined) {
    return serializedContents;
  }

  return [
    serializeGoogleGenAISystemInstruction(systemInstruction, state),
    ...(Array.isArray(serializedContents)
      ? serializedContents
      : [serializedContents]),
  ];
}

function serializeGoogleGenAISystemInstruction(
  systemInstruction: unknown,
  state: GoogleGenAISerializationState,
): unknown {
  const serialized = serializeGoogleGenAIContentsInternal(
    systemInstruction,
    state,
  );
  if (
    !isObject(serialized) ||
    Array.isArray(serialized) ||
    !Array.isArray(read(serialized, "parts"))
  ) {
    return {
      role: "system",
      parts: Array.isArray(serialized) ? serialized : [serialized],
    };
  }

  return Object.fromEntries([
    ...Object.keys(serialized)
      .filter((key) => key !== "role")
      .map((key) => [key, read(serialized, key)] as const),
    ["role", "system"],
  ]);
}

export function serializeGoogleGenAITools(tools: unknown): unknown[] {
  if (!Array.isArray(tools)) {
    return [];
  }

  const serialized: unknown[] = [];
  for (const tool of tools) {
    const declarations = read(tool, "functionDeclarations");
    if (Array.isArray(declarations)) {
      for (const declaration of declarations) {
        const name = read(declaration, "name");
        if (typeof name !== "string" || name.length === 0) {
          continue;
        }
        const description = read(declaration, "description");
        const parametersJsonSchema = read(declaration, "parametersJsonSchema");
        const parameters = read(declaration, "parameters");
        const definition: Record<string, unknown> = { name };
        if (typeof description === "string") {
          definition.description = description;
        }
        if (parametersJsonSchema !== undefined) {
          definition.parameters =
            serializeGoogleGenAIValue(parametersJsonSchema);
        } else if (parameters !== undefined) {
          definition.parameters = normalizeGoogleGenAISchema(parameters);
        }
        serialized.push({ type: "function", function: definition });
      }
    }

    for (const type of BUILT_IN_TOOL_FIELDS) {
      const config = read(tool, type);
      if (config !== undefined) {
        serialized.push({
          type,
          config: serializeGoogleGenAIBuiltInToolConfig(type, config),
        });
      }
    }
  }
  return serialized;
}

function normalizeGoogleGenAISchema(value: unknown): unknown {
  const serialized = serializeGoogleGenAIValue(value);
  if (!isObject(serialized) || Array.isArray(serialized)) {
    return serialized;
  }

  const entries: Array<[string, unknown]> = [];
  for (const key of Object.keys(serialized)) {
    const entry = read(serialized, key);
    if (key === "type" && typeof entry === "string") {
      if (entry !== "TYPE_UNSPECIFIED") {
        entries.push([key, entry.toLowerCase()]);
      }
    } else if (key === "anyOf" && Array.isArray(entry)) {
      entries.push([key, entry.map(normalizeGoogleGenAISchema)]);
    } else if (key === "items") {
      entries.push([key, normalizeGoogleGenAISchema(entry)]);
    } else if (key === "properties" && isObject(entry)) {
      entries.push([
        key,
        Object.fromEntries(
          Object.keys(entry).map((property) => [
            property,
            normalizeGoogleGenAISchema(read(entry, property)),
          ]),
        ),
      ]);
    } else {
      entries.push([key, entry]);
    }
  }
  return Object.fromEntries(entries);
}

function sanitizeGoogleGenAIToolUrl(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function addGoogleGenAIRetrievalExternalApi(
  entries: Array<[string, unknown]>,
  config: unknown,
): void {
  const apiSpec = read(config, "apiSpec");
  if (typeof apiSpec === "string") {
    entries.push(["apiSpec", apiSpec]);
  }
  const endpoint = sanitizeGoogleGenAIToolUrl(read(config, "endpoint"));
  if (endpoint !== undefined) {
    entries.push(["endpoint", endpoint]);
  }
  const elastic = read(config, "elasticSearchParams");
  const elasticEntries: Array<[string, unknown]> = [];
  for (const key of ["index", "searchTemplate"] as const) {
    const value = read(elastic, key);
    if (typeof value === "string") {
      elasticEntries.push([key, value]);
    }
  }
  const numHits = read(elastic, "numHits");
  if (typeof numHits === "number" && Number.isFinite(numHits)) {
    elasticEntries.push(["numHits", numHits]);
  }
  if (elasticEntries.length > 0) {
    entries.push(["elasticSearchParams", Object.fromEntries(elasticEntries)]);
  }
  if (isObject(read(config, "simpleSearchParams"))) {
    entries.push(["simpleSearchParams", {}]);
  }
}

function selectGoogleGenAIRagRetrievalConfig(value: unknown): unknown {
  const entries: Array<[string, unknown]> = [];
  const topK = read(value, "topK");
  if (typeof topK === "number" && Number.isFinite(topK)) {
    entries.push(["topK", topK]);
  }

  const filter = read(value, "filter");
  const filterEntries: Array<[string, unknown]> = [];
  const metadataFilter = read(filter, "metadataFilter");
  if (typeof metadataFilter === "string") {
    filterEntries.push(["metadataFilter", metadataFilter]);
  }
  for (const key of [
    "vectorDistanceThreshold",
    "vectorSimilarityThreshold",
  ] as const) {
    const entry = read(filter, key);
    if (typeof entry === "number" && Number.isFinite(entry)) {
      filterEntries.push([key, entry]);
    }
  }
  if (filterEntries.length > 0) {
    entries.push(["filter", Object.fromEntries(filterEntries)]);
  }

  const alpha = read(read(value, "hybridSearch"), "alpha");
  if (typeof alpha === "number" && Number.isFinite(alpha)) {
    entries.push(["hybridSearch", { alpha }]);
  }

  const ranking = read(value, "ranking");
  const rankingEntries: Array<[string, unknown]> = [];
  for (const key of ["llmRanker", "rankService"] as const) {
    const modelName = read(read(ranking, key), "modelName");
    if (typeof modelName === "string") {
      rankingEntries.push([key, { modelName }]);
    }
  }
  if (rankingEntries.length > 0) {
    entries.push(["ranking", Object.fromEntries(rankingEntries)]);
  }

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function serializeGoogleGenAIBuiltInToolConfig(
  type: (typeof BUILT_IN_TOOL_FIELDS)[number],
  config: unknown,
): unknown {
  const entries: Array<[string, unknown]> = [];
  const addString = (key: string, value: unknown) => {
    if (typeof value === "string") {
      entries.push([key, value]);
    }
  };
  const addNumber = (key: string, value: unknown) => {
    if (typeof value === "number" && Number.isFinite(value)) {
      entries.push([key, value]);
    }
  };
  const addBoolean = (key: string, value: unknown) => {
    if (typeof value === "boolean") {
      entries.push([key, value]);
    }
  };
  const addStrings = (key: string, value: unknown) => {
    if (
      Array.isArray(value) &&
      value.every((item) => typeof item === "string")
    ) {
      entries.push([key, value]);
    }
  };

  switch (type) {
    case "computerUse":
      addString("environment", read(config, "environment"));
      addStrings(
        "excludedPredefinedFunctions",
        read(config, "excludedPredefinedFunctions"),
      );
      addBoolean(
        "enablePromptInjectionDetection",
        read(config, "enablePromptInjectionDetection"),
      );
      break;
    case "enterpriseWebSearch":
      addString("blockingConfidence", read(config, "blockingConfidence"));
      addStrings("excludeDomains", read(config, "excludeDomains"));
      break;
    case "fileSearch":
      addStrings("fileSearchStoreNames", read(config, "fileSearchStoreNames"));
      addNumber("topK", read(config, "topK"));
      addString("metadataFilter", read(config, "metadataFilter"));
      break;
    case "googleMaps":
      addBoolean("enableWidget", read(config, "enableWidget"));
      break;
    case "googleSearch": {
      addString("blockingConfidence", read(config, "blockingConfidence"));
      addStrings("excludeDomains", read(config, "excludeDomains"));
      const searchTypes = read(config, "searchTypes");
      const selectedSearchTypes: Array<[string, unknown]> = [];
      if (read(searchTypes, "webSearch") !== undefined) {
        selectedSearchTypes.push(["webSearch", {}]);
      }
      if (read(searchTypes, "imageSearch") !== undefined) {
        selectedSearchTypes.push(["imageSearch", {}]);
      }
      if (selectedSearchTypes.length > 0) {
        entries.push(["searchTypes", Object.fromEntries(selectedSearchTypes)]);
      }
      const timeRange = read(config, "timeRangeFilter");
      const selectedRange: Array<[string, unknown]> = [];
      for (const key of ["startTime", "endTime"] as const) {
        const value = read(timeRange, key);
        if (typeof value === "string") {
          selectedRange.push([key, value]);
        }
      }
      if (selectedRange.length > 0) {
        entries.push(["timeRangeFilter", Object.fromEntries(selectedRange)]);
      }
      break;
    }
    case "googleSearchRetrieval": {
      const dynamic = read(config, "dynamicRetrievalConfig");
      const selectedDynamic: Array<[string, unknown]> = [];
      const mode = read(dynamic, "mode");
      const threshold = read(dynamic, "dynamicThreshold");
      if (typeof mode === "string") {
        selectedDynamic.push(["mode", mode]);
      }
      if (typeof threshold === "number" && Number.isFinite(threshold)) {
        selectedDynamic.push(["dynamicThreshold", threshold]);
      }
      if (selectedDynamic.length > 0) {
        entries.push([
          "dynamicRetrievalConfig",
          Object.fromEntries(selectedDynamic),
        ]);
      }
      break;
    }
    case "mcpServers": {
      if (!Array.isArray(config)) {
        break;
      }
      const servers = config.map((server) => {
        const serverEntries: Array<[string, unknown]> = [];
        const name = read(server, "name");
        if (typeof name === "string") {
          serverEntries.push(["name", name]);
        }
        const transport = read(server, "streamableHttpTransport");
        const transportEntries: Array<[string, unknown]> = [];
        for (const key of ["sseReadTimeout", "timeout"] as const) {
          const value = read(transport, key);
          if (typeof value === "string") {
            transportEntries.push([key, value]);
          }
        }
        const terminateOnClose = read(transport, "terminateOnClose");
        if (typeof terminateOnClose === "boolean") {
          transportEntries.push(["terminateOnClose", terminateOnClose]);
        }
        const url = sanitizeGoogleGenAIToolUrl(read(transport, "url"));
        if (url !== undefined) {
          transportEntries.push(["url", url]);
        }
        if (transportEntries.length > 0) {
          serverEntries.push([
            "streamableHttpTransport",
            Object.fromEntries(transportEntries),
          ]);
        }
        return Object.fromEntries(serverEntries);
      });
      entries.push(["servers", servers]);
      break;
    }
    case "parallelAiSearch": {
      const custom = read(config, "customConfigs");
      const selected: Array<[string, unknown]> = [];
      const mode = read(custom, "mode");
      if (typeof mode === "string") {
        selected.push(["mode", mode]);
      }
      const maxResults = read(custom, "max_results");
      if (typeof maxResults === "number" && Number.isFinite(maxResults)) {
        selected.push(["max_results", maxResults]);
      }
      const sourcePolicy = read(custom, "source_policy");
      const selectedSourcePolicy: Array<[string, unknown]> = [];
      for (const key of ["include_domains", "exclude_domains"] as const) {
        const value = read(sourcePolicy, key);
        if (
          Array.isArray(value) &&
          value.every((item) => typeof item === "string")
        ) {
          selectedSourcePolicy.push([key, value]);
        }
      }
      if (selectedSourcePolicy.length > 0) {
        selected.push([
          "source_policy",
          Object.fromEntries(selectedSourcePolicy),
        ]);
      }
      const maxAgeSeconds = read(
        read(custom, "fetch_policy"),
        "max_age_seconds",
      );
      if (typeof maxAgeSeconds === "number" && Number.isFinite(maxAgeSeconds)) {
        selected.push(["fetch_policy", { max_age_seconds: maxAgeSeconds }]);
      }
      const excerpts = read(custom, "excerpts");
      const selectedExcerpts: Array<[string, unknown]> = [];
      for (const key of ["max_chars_per_result", "max_chars_total"] as const) {
        const value = read(excerpts, key);
        if (typeof value === "number" && Number.isFinite(value)) {
          selectedExcerpts.push([key, value]);
        }
      }
      if (selectedExcerpts.length > 0) {
        selected.push(["excerpts", Object.fromEntries(selectedExcerpts)]);
      }
      if (selected.length > 0) {
        entries.push(["customConfigs", Object.fromEntries(selected)]);
      }
      break;
    }
    case "retrieval": {
      addBoolean("disableAttribution", read(config, "disableAttribution"));
      const externalApi = read(config, "externalApi");
      const externalEntries: Array<[string, unknown]> = [];
      addGoogleGenAIRetrievalExternalApi(externalEntries, externalApi);
      if (externalEntries.length > 0) {
        entries.push(["externalApi", Object.fromEntries(externalEntries)]);
      }

      const vertexAiSearch = read(config, "vertexAiSearch");
      const searchEntries: Array<[string, unknown]> = [];
      for (const key of ["datastore", "engine", "filter"] as const) {
        const value = read(vertexAiSearch, key);
        if (typeof value === "string") {
          searchEntries.push([key, value]);
        }
      }
      const maxResults = read(vertexAiSearch, "maxResults");
      if (typeof maxResults === "number" && Number.isFinite(maxResults)) {
        searchEntries.push(["maxResults", maxResults]);
      }
      const dataStoreSpecs = read(vertexAiSearch, "dataStoreSpecs");
      if (Array.isArray(dataStoreSpecs)) {
        searchEntries.push([
          "dataStoreSpecs",
          dataStoreSpecs.map((spec) =>
            Object.fromEntries(
              ["dataStore", "filter"].flatMap((key) => {
                const value = read(spec, key);
                return typeof value === "string" ? [[key, value]] : [];
              }),
            ),
          ),
        ]);
      }
      if (searchEntries.length > 0) {
        entries.push(["vertexAiSearch", Object.fromEntries(searchEntries)]);
      }

      const vertexRagStore = read(config, "vertexRagStore");
      const ragEntries: Array<[string, unknown]> = [];
      const ragCorpora = read(vertexRagStore, "ragCorpora");
      if (
        Array.isArray(ragCorpora) &&
        ragCorpora.every((item) => typeof item === "string")
      ) {
        ragEntries.push(["ragCorpora", ragCorpora]);
      }
      const ragResources = read(vertexRagStore, "ragResources");
      if (Array.isArray(ragResources)) {
        ragEntries.push([
          "ragResources",
          ragResources.map((resource) => {
            const resourceEntries: Array<[string, unknown]> = [];
            const ragCorpus = read(resource, "ragCorpus");
            const ragFileIds = read(resource, "ragFileIds");
            if (typeof ragCorpus === "string") {
              resourceEntries.push(["ragCorpus", ragCorpus]);
            }
            if (
              Array.isArray(ragFileIds) &&
              ragFileIds.every((item) => typeof item === "string")
            ) {
              resourceEntries.push(["ragFileIds", ragFileIds]);
            }
            return Object.fromEntries(resourceEntries);
          }),
        ]);
      }
      for (const key of [
        "similarityTopK",
        "vectorDistanceThreshold",
      ] as const) {
        const value = read(vertexRagStore, key);
        if (typeof value === "number" && Number.isFinite(value)) {
          ragEntries.push([key, value]);
        }
      }
      const storeContext = read(vertexRagStore, "storeContext");
      if (typeof storeContext === "boolean") {
        ragEntries.push(["storeContext", storeContext]);
      }
      const ragRetrievalConfig = selectGoogleGenAIRagRetrievalConfig(
        read(vertexRagStore, "ragRetrievalConfig"),
      );
      if (ragRetrievalConfig !== undefined) {
        ragEntries.push(["ragRetrievalConfig", ragRetrievalConfig]);
      }
      if (ragEntries.length > 0) {
        entries.push(["vertexRagStore", Object.fromEntries(ragEntries)]);
      }
      break;
    }
    case "codeExecution":
    case "urlContext":
      break;
  }

  return Object.fromEntries(entries);
}

export function normalizeGoogleGenAIToolChoice(
  toolConfig: unknown,
):
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } }
  | undefined {
  const functionCalling = read(toolConfig, "functionCallingConfig");
  const mode = read(functionCalling, "mode");
  if (mode === "NONE") {
    return "none";
  }
  if (mode === "AUTO" || mode === "VALIDATED") {
    return "auto";
  }
  if (mode !== "ANY") {
    return undefined;
  }
  const names = read(functionCalling, "allowedFunctionNames");
  if (
    Array.isArray(names) &&
    names.length === 1 &&
    typeof names[0] === "string" &&
    names[0].length > 0
  ) {
    return { type: "function", function: { name: names[0] } };
  }
  return "required";
}

type GoogleGenAISerializationOptions = {
  attachmentKey?: (index: number) => string;
  preserveInlineData?: boolean;
};

type GoogleGenAISerializationState = GoogleGenAISerializationOptions & {
  nextAttachmentIndex: number;
  seen: WeakSet<object>;
};

function createGoogleGenAISerializationState(
  options: GoogleGenAISerializationOptions = {},
): GoogleGenAISerializationState {
  return {
    ...options,
    nextAttachmentIndex: 0,
    seen: new WeakSet<object>(),
  };
}

export function serializeGoogleGenAIResponse(
  value: unknown,
  options: GoogleGenAISerializationOptions = {},
): Record<string, unknown> | undefined {
  const response = resolveGoogleGenAIObject(value);
  const state = createGoogleGenAISerializationState(options);
  const entries: Array<[string, unknown]> = [];
  for (const key of GENERATE_CONTENT_RESPONSE_FIELDS) {
    const entry = read(response, key);
    if (entry !== undefined) {
      entries.push([key, serializeGoogleGenAIValueInternal(entry, state)]);
    }
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function extractGoogleGenAIResponseMetadata(
  value: unknown,
  options: GoogleGenAISerializationOptions = {},
): Record<string, unknown> | undefined {
  const response = resolveGoogleGenAIObject(value);
  const state = createGoogleGenAISerializationState(options);
  const entries: Array<[string, unknown]> = [];
  const modelVersion = read(response, "modelVersion");
  if (typeof modelVersion === "string" && modelVersion.length > 0) {
    entries.push(["model", modelVersion]);
  }

  const responseGroundingMetadata = read(response, "groundingMetadata");
  const candidateGroundingMetadata: unknown[] = [];
  const candidates = read(response, "candidates");
  if (Array.isArray(candidates)) {
    for (const candidate of candidates) {
      const groundingMetadata = read(candidate, "groundingMetadata");
      if (groundingMetadata !== undefined) {
        candidateGroundingMetadata.push(groundingMetadata);
      }
    }
  }

  let groundingMetadata: unknown;
  if (responseGroundingMetadata !== undefined) {
    groundingMetadata = responseGroundingMetadata;
  } else if (candidateGroundingMetadata.length === 1) {
    [groundingMetadata] = candidateGroundingMetadata;
  } else if (candidateGroundingMetadata.length > 1) {
    groundingMetadata = candidateGroundingMetadata;
  }
  if (groundingMetadata !== undefined) {
    entries.push([
      "groundingMetadata",
      serializeGoogleGenAIValueInternal(groundingMetadata, state),
    ]);
  }

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function serializeGoogleGenAIContents(contents: unknown): unknown {
  return serializeGoogleGenAIContentsInternal(
    contents,
    createGoogleGenAISerializationState(),
  );
}

function serializeGoogleGenAIContentsInternal(
  contents: unknown,
  state: GoogleGenAISerializationState,
): unknown {
  if (Array.isArray(contents)) {
    state.seen.add(contents);
    try {
      return contents.map((content) =>
        serializeGoogleGenAIContent(content, state),
      );
    } finally {
      state.seen.delete(contents);
    }
  }
  return serializeGoogleGenAIContent(contents, state);
}

function serializeGoogleGenAIContent(
  content: unknown,
  state: GoogleGenAISerializationState,
): unknown {
  if (typeof content === "string") {
    return { text: content };
  }
  return serializeGoogleGenAIValueInternal(content, state);
}

export function serializeGoogleGenAIValue(value: unknown): unknown {
  return serializeGoogleGenAIValueInternal(
    value,
    createGoogleGenAISerializationState(),
  );
}

function serializeGoogleGenAIInlineData(
  value: object,
  state: GoogleGenAISerializationState,
): unknown | undefined {
  if (state.preserveInlineData) {
    return undefined;
  }

  const inlineData = read(value, "inlineData");
  if (!isObject(inlineData)) {
    return undefined;
  }
  const data = read(inlineData, "data");
  const mimeType = read(inlineData, "mimeType");
  if (
    (typeof data !== "string" && !(data instanceof Uint8Array)) ||
    typeof mimeType !== "string"
  ) {
    return undefined;
  }

  try {
    const bytes =
      typeof data === "string"
        ? Uint8Array.from(atob(data), (character) => character.charCodeAt(0))
        : data;
    const filename = `file.${mimeType.split("/")[1] ?? "bin"}`;
    const attachmentParams = {
      data: bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ),
      filename,
      contentType: mimeType,
    };
    const attachment = state.attachmentKey
      ? _internalCreateAttachment(
          attachmentParams,
          state.attachmentKey(state.nextAttachmentIndex++),
        )
      : new Attachment(attachmentParams);
    return mimeType.startsWith("image/")
      ? { image_url: { url: attachment } }
      : { file: { file_data: attachment, filename } };
  } catch {
    return undefined;
  }
}

function serializeGoogleGenAIValueInternal(
  value: unknown,
  state: GoogleGenAISerializationState,
): unknown {
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    if (state.seen.has(value)) {
      return "[Circular]";
    }
    state.seen.add(value);
    try {
      return value.map((entry) =>
        serializeGoogleGenAIValueInternal(entry, state),
      );
    } finally {
      state.seen.delete(value);
    }
  }
  if (state.seen.has(value)) {
    return "[Circular]";
  }
  state.seen.add(value);
  try {
    const inlineData = serializeGoogleGenAIInlineData(value, state);
    if (inlineData !== undefined) {
      return inlineData;
    }

    return Object.fromEntries(
      Object.keys(value).map((key) => [
        key,
        serializeGoogleGenAIValueInternal(read(value, key), state),
      ]),
    );
  } finally {
    state.seen.delete(value);
  }
}

function usageNumber(usage: unknown, key: string): number | undefined {
  const value = read(usage, key);
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

export function populateGoogleGenAIUsageMetrics(
  metrics: Record<string, number>,
  usage: GoogleGenAIUsageMetadata | unknown,
): void {
  const prompt = usageNumber(usage, "promptTokenCount");
  const tool = usageNumber(usage, "toolUsePromptTokenCount");
  const candidates = usageNumber(usage, "candidatesTokenCount");
  const thoughts = usageNumber(usage, "thoughtsTokenCount");
  const total = usageNumber(usage, "totalTokenCount");
  const cached = usageNumber(usage, "cachedContentTokenCount");

  if (prompt !== undefined || tool !== undefined) {
    metrics.prompt_tokens = (prompt ?? 0) + (tool ?? 0);
  }
  if (candidates !== undefined || thoughts !== undefined) {
    metrics.completion_tokens = (candidates ?? 0) + (thoughts ?? 0);
  }
  if (total !== undefined) {
    metrics.tokens = total;
  }
  if (cached !== undefined) {
    metrics.prompt_cached_tokens = cached;
  }
  if (thoughts !== undefined) {
    metrics.completion_reasoning_tokens = thoughts;
  }

  const promptDetails = read(usage, "promptTokensDetails");
  if (Array.isArray(promptDetails)) {
    for (const detail of promptDetails) {
      const tokenCount = usageNumber(detail, "tokenCount");
      if (read(detail, "modality") === "AUDIO" && tokenCount !== undefined) {
        metrics.prompt_audio_tokens =
          (metrics.prompt_audio_tokens ?? 0) + tokenCount;
      }
    }
  }

  const candidateDetails = read(usage, "candidatesTokensDetails");
  if (Array.isArray(candidateDetails)) {
    for (const detail of candidateDetails) {
      const tokenCount = usageNumber(detail, "tokenCount");
      if (read(detail, "modality") === "AUDIO" && tokenCount !== undefined) {
        metrics.completion_audio_tokens =
          (metrics.completion_audio_tokens ?? 0) + tokenCount;
      }
      if (read(detail, "modality") === "IMAGE" && tokenCount !== undefined) {
        metrics.completion_image_tokens =
          (metrics.completion_image_tokens ?? 0) + tokenCount;
      }
    }
  }
}
