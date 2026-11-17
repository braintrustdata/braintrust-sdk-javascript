import { createCacheLayers } from "../prompt-cache/cache-config";
import {
  PromptCache,
  type PromptDiskCacheEntry,
  type PromptMemoryCacheEntry,
} from "../prompt-cache/prompt-cache";
import {
  ParametersCache,
  type ParametersDiskCacheEntry,
  type ParametersMemoryCacheEntry,
} from "../prompt-cache/parameters-cache";
import iso from "#braintrust-platform";
import type { ResolvedLoaderLoginOptions } from "./core";
/// <reference lib="dom" />
import { debugLogger } from "../debug-logger";
import {
  TRANSACTION_ID_FIELD,
  TransactionId,
  isArray,
  isObject,
  getObjValueByPath,
} from "../util";
import {
  BraintrustAttachmentReference as BraintrustAttachmentReferenceSchema,
  ChatCompletionTool as chatCompletionToolSchema,
  ExternalAttachmentReference as ExternalAttachmentReferenceSchema,
  PromptData as promptDataSchema,
  Prompt as promptSchema,
} from "../sdk-schemas";
import type {
  ChatCompletionTool,
  ModelParams,
  ChatCompletionMessageParam as Message,
  ChatCompletionOpenAIMessageParam as OpenAIMessage,
  PromptData,
  FunctionTypeEnum,
  PromptSessionEvent,
  PromptBlockData,
} from "../sdk-types";
import {
  parseTemplateFormat,
  renderTemplateContent,
} from "../template/renderer";
import type { TemplateFormat } from "../template/registry";
import { z } from "zod/v3";
import { isEmpty } from "../util";
import { prettifyXact } from "../../util/index";
import type { EvalParameters, InferParameters } from "../eval-parameters";
import {
  FullLoginOptions,
  BraintrustState,
  LoaderRequestState,
  _internalGetGlobalState,
  isLoaderCacheFallbackError,
  InlineAttachmentReferenceSchema,
  resolveAttachmentsToBase64,
  ReadonlyAttachment,
  BTQL_HTTP_RETRIES,
} from "./core";

const BRAINTRUST_PARAMS = [
  "use_cache",
  "reasoning_enabled",
  "reasoning_budget",
];

const parametersRowSchema = z.object({
  id: z.string().uuid(),
  _xact_id: z.string(),
  project_id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  description: z.union([z.string(), z.null()]).optional(),
  function_type: z.literal("parameters"),
  function_data: z.object({
    type: z.literal("parameters"),
    data: z.record(z.unknown()).optional(),
    __schema: z.record(z.unknown()),
  }),
  metadata: z
    .union([z.object({}).partial().passthrough(), z.null()])
    .optional(),
});

export type ParametersRow = {
  id: string;
  _xact_id: string;
  project_id: string;
  name: string;
  slug: string;
  description?: string | null;
  function_type: "parameters";
  function_data: {
    type: "parameters";
    data?: Record<string, unknown>;
    __schema: Record<string, unknown>;
  };
  metadata?: Record<string, unknown> | null;
};

type LoadPromptOptions = FullLoginOptions & {
  projectName?: string;
  projectId?: string;
  slug?: string;
  version?: string;
  id?: string;
  defaults?: DefaultPromptArgs;
  noTrace?: boolean;
  environment?: string;
  state?: BraintrustState;
};

type LoadParametersBaseOptions = FullLoginOptions & {
  state?: BraintrustState;
};

type LoadParametersByIdOptions = LoadParametersBaseOptions & {
  id: string;
  version?: string;
};

type LoadParametersByIdWithEnvOptions = LoadParametersBaseOptions & {
  id: string;
  environment: string;
  version?: string;
};

type LoadParametersByProjectNameOptions = LoadParametersBaseOptions & {
  projectName: string;
  slug: string;
  version?: string;
};

type LoadParametersByProjectNameWithEnvOptions = LoadParametersBaseOptions & {
  projectName: string;
  slug: string;
  environment: string;
  version?: string;
};

type LoadParametersByProjectIdOptions = LoadParametersBaseOptions & {
  projectId: string;
  slug: string;
  version?: string;
};

type LoadParametersByProjectIdWithEnvOptions = LoadParametersBaseOptions & {
  projectId: string;
  slug: string;
  environment: string;
  version?: string;
};

type LoadParametersImplementationOptions = LoadParametersBaseOptions & {
  projectName?: string;
  projectId?: string;
  slug?: string;
  version?: string;
  id?: string;
  environment?: string;
};

type LoaderRequestResult<T> =
  | ({ ok: true; response: T } & LoaderCacheViews)
  | ({ ok: false; error: unknown } & LoaderCacheViews);

async function runCredentialScopedLoaderRequest<T>(
  state: BraintrustState,
  loginOptions: Pick<
    FullLoginOptions,
    "apiKey" | "appUrl" | "orgName" | "fetch" | "forceLogin"
  >,
  request: (requestState: LoaderRequestState) => Promise<T>,
): Promise<LoaderRequestResult<T>> {
  const resolvedLoginOptions =
    await state._internalResolveLoaderLoginOptions(loginOptions);
  let cacheViews = getLoaderCacheViews(state, resolvedLoginOptions);

  try {
    const requestState =
      await state._internalGetLoaderState(resolvedLoginOptions);
    cacheViews = getLoaderCacheViews(state, resolvedLoginOptions, requestState);
    return {
      ok: true,
      response: await request(requestState),
      ...cacheViews,
    };
  } catch (error) {
    return { ok: false, error, ...cacheViews };
  }
}

/**
 * Load a prompt from the specified project.
 *
 * @param options Options for configuring loadPrompt().
 * @param options.projectName The name of the project to load the prompt from. Must specify at least one of `projectName` or `projectId`.
 * @param options.projectId The id of the project to load the prompt from. This takes precedence over `projectName` if specified.
 * @param options.slug The slug of the prompt to load.
 * @param options.version An optional version of the prompt (to read). If not specified, the latest version will be used.
 * @param options.environment Fetch the version of the prompt assigned to the specified environment (e.g. "production", "staging"). If both `version` and `environment` are provided, `version` takes precedence.
 * @param options.id The id of a specific prompt to load. If specified, this takes precedence over all other parameters (project and slug).
 * @param options.defaults (Optional) A dictionary of default values to use when rendering the prompt. Prompt values will override these defaults.
 * @param options.noTrace If true, do not include logging metadata for this prompt when build() is called.
 * @param options.appUrl The URL of the Braintrust App. Defaults to https://www.braintrust.dev.
 * @param options.apiKey The API key to use for this request, independently of any existing global login. If the parameter is not specified, will use an existing login or try the `BRAINTRUST_API_KEY` environment variable. In Node.js,
 * if that is unset, will try the nearest `.env.braintrust` file in the current working directory or parent directories. If no API key is specified, will prompt the user to login.
 * @param options.orgName (Optional) The name of a specific organization to connect to. This is useful if you belong to multiple.
 * @returns The prompt object.
 * @throws If the prompt is not found.
 * @throws If multiple prompts are found with the same slug in the same project (this should never happen).
 *
 * @example
 * ```javascript
 * const prompt = await loadPrompt({
 *  projectName: "My Project",
 *  slug: "my-prompt",
 * });
 * ```
 */
export async function loadPrompt({
  projectName,
  projectId,
  slug,
  version,
  environment,
  id,
  defaults,
  noTrace = false,
  appUrl,
  apiKey,
  orgName,
  fetch,
  forceLogin,
  state: stateArg,
}: LoadPromptOptions): Promise<Prompt<true, true>> {
  const versionOrEnvironment = version
    ? { version }
    : environment
      ? { environment }
      : {};
  if (id) {
    // When loading by ID, we don't need project or slug
  } else if (isEmpty(projectName) && isEmpty(projectId)) {
    throw new Error("Must specify either projectName or projectId");
  } else if (isEmpty(slug)) {
    throw new Error("Must specify slug");
  }

  const state = stateArg ?? _internalGetGlobalState();
  const result = await runCredentialScopedLoaderRequest(
    state,
    { orgName, apiKey, appUrl, fetch, forceLogin },
    async (requestState) => {
      let response;
      if (id) {
        // Load prompt by ID using the /v1/prompt/{id} endpoint
        response = await requestState
          .apiConn()
          .get_json(`v1/prompt/${id}`, versionOrEnvironment);
        // Wrap single prompt response in objects array to match list API format
        if (response) {
          response = { objects: [response] };
        }
      } else {
        response = await requestState.apiConn().get_json("v1/prompt", {
          project_name: projectName,
          project_id: projectId,
          slug,
          ...versionOrEnvironment,
        });
      }
      return response;
    },
  );
  const { promptCache } = result;
  if (!result.ok) {
    const e = result.error;
    if (!isLoaderCacheFallbackError(e)) {
      throw e;
    }
    // If environment or version was specified, don't fall back to cache
    if (version || environment) {
      throw new Error(`Prompt not found with specified parameters: ${e}`);
    }

    debugLogger
      .forState(state)
      .warn("Failed to load prompt, attempting to fall back to cache:", e);
    let prompt;
    if (id) {
      prompt = await promptCache.get({ id });
      if (!prompt) {
        throw new Error(
          `Prompt with id ${id} not found (not found on server or in local cache): ${e}`,
        );
      }
    } else {
      prompt = await promptCache.get({
        slug,
        projectId,
        projectName,
        version: version ?? "latest",
      });
      if (!prompt) {
        throw new Error(
          `Prompt ${slug} (version ${version ?? "latest"}) not found in ${[
            projectName ?? projectId,
          ]} (not found on server or in local cache): ${e}`,
        );
      }
    }
    return prompt;
  }
  const { response } = result;

  if (!("objects" in response) || response.objects.length === 0) {
    if (id) {
      throw new Error(`Prompt with id ${id} not found.`);
    } else {
      throw new Error(
        `Prompt ${slug} not found in ${[projectName ?? projectId]}`,
      );
    }
  } else if (response.objects.length > 1) {
    if (id) {
      throw new Error(
        `Multiple prompts found with id ${id}. This should never happen.`,
      );
    } else {
      throw new Error(
        `Multiple prompts found with slug ${slug} in project ${
          projectName ?? projectId
        }. This should never happen.`,
      );
    }
  }

  const metadata = promptSchema.parse(response["objects"][0]);
  const prompt = new Prompt(metadata, defaults || {}, noTrace);
  try {
    if (id) {
      await promptCache.set({ id }, prompt);
    } else if (slug) {
      await promptCache.set(
        { slug, projectId, projectName, version: version ?? "latest" },
        prompt,
      );
    }
  } catch (e) {
    debugLogger.forState(state).warn("Failed to set prompt in cache:", e);
  }
  return prompt;
}

/**
 * Load parameters from the specified project.
 *
 * @param options Options for configuring loadParameters().
 * @param options.projectName The name of the project to load the parameters from. Must specify at least one of `projectName` or `projectId`.
 * @param options.projectId The id of the project to load the parameters from. This takes precedence over `projectName` if specified.
 * @param options.slug The slug of the parameters to load.
 * @param options.version An optional version of the parameters (to read). If not specified, the latest version will be used.
 * @param options.environment Fetch the version of the parameters assigned to the specified environment (e.g. "production", "staging"). If both `version` and `environment` are provided, `version` takes precedence.
 * @param options.id The id of specific parameters to load. If specified, this takes precedence over all other parameters (project and slug).
 * @param options.appUrl The URL of the Braintrust App. Defaults to https://www.braintrust.dev.
 * @param options.apiKey The API key to use for this request, independently of any existing global login. If the parameter is not specified, will use an existing login or try the `BRAINTRUST_API_KEY` environment variable. In Node.js, if that is unset, will try the nearest `.env.braintrust` file in the current working directory or parent directories.
 * @param options.orgName (Optional) The name of a specific organization to connect to. This is useful if you belong to multiple.
 * @returns The parameters object.
 * @throws If the parameters are not found.
 * @throws If multiple parameters are found with the same slug in the same project (this should never happen).
 *
 * @example
 * ```typescript
 * const params = await loadParameters({
 *  projectName: "My Project",
 *  slug: "my-parameters",
 * });
 * ```
 */
export function loadParameters<S extends EvalParameters = EvalParameters>(
  options: LoadParametersByProjectNameOptions,
): Promise<RemoteEvalParameters<true, true, InferParameters<S>>>;

export function loadParameters<S extends EvalParameters = EvalParameters>(
  options: LoadParametersByProjectNameWithEnvOptions,
): Promise<RemoteEvalParameters<true, true, InferParameters<S>>>;

export function loadParameters<S extends EvalParameters = EvalParameters>(
  options: LoadParametersByProjectIdOptions,
): Promise<RemoteEvalParameters<true, true, InferParameters<S>>>;

export function loadParameters<S extends EvalParameters = EvalParameters>(
  options: LoadParametersByProjectIdWithEnvOptions,
): Promise<RemoteEvalParameters<true, true, InferParameters<S>>>;

export function loadParameters<S extends EvalParameters = EvalParameters>(
  options: LoadParametersByIdOptions,
): Promise<RemoteEvalParameters<true, true, InferParameters<S>>>;

export function loadParameters<S extends EvalParameters = EvalParameters>(
  options: LoadParametersByIdWithEnvOptions,
): Promise<RemoteEvalParameters<true, true, InferParameters<S>>>;

export async function loadParameters<
  S extends EvalParameters = EvalParameters,
>({
  projectName,
  projectId,
  slug,
  version,
  environment,
  id,
  appUrl,
  apiKey,
  orgName,
  fetch,
  forceLogin,
  state: stateArg,
}: LoadParametersImplementationOptions): Promise<
  RemoteEvalParameters<true, true, InferParameters<S>>
> {
  const versionOrEnvironment = version
    ? { version }
    : environment
      ? { environment }
      : {};
  if (id) {
    // When loading by ID, we don't need project or slug
  } else if (isEmpty(projectName) && isEmpty(projectId)) {
    throw new Error("Must specify either projectName or projectId");
  } else if (isEmpty(slug)) {
    throw new Error("Must specify slug");
  }

  const state = stateArg ?? _internalGetGlobalState();
  const result = await runCredentialScopedLoaderRequest(
    state,
    { orgName, apiKey, appUrl, fetch, forceLogin },
    async (requestState) => {
      let response;
      if (id) {
        response = await requestState.apiConn().get_json(`v1/function/${id}`, {
          ...versionOrEnvironment,
        });
        if (response) {
          response = { objects: [response] };
        }
      } else {
        response = await requestState.apiConn().get_json("v1/function", {
          project_name: projectName,
          project_id: projectId,
          slug,
          function_type: "parameters",
          ...versionOrEnvironment,
        });
      }
      return response;
    },
  );
  const { parametersCache } = result;
  if (!result.ok) {
    const e = result.error;
    if (!isLoaderCacheFallbackError(e)) {
      throw e;
    }
    if (version || environment) {
      throw new Error(`Parameters not found with specified parameters: ${e}`);
    }

    debugLogger
      .forState(state)
      .warn("Failed to load parameters, attempting to fall back to cache:", e);
    let parameters;
    if (id) {
      parameters = await parametersCache.get({ id });
      if (!parameters) {
        throw new Error(
          `Parameters with id ${id} not found (not found on server or in local cache): ${e}`,
        );
      }
    } else {
      parameters = await parametersCache.get({
        slug,
        projectId,
        projectName,
        version: version ?? "latest",
      });
      if (!parameters) {
        throw new Error(
          `Parameters ${slug} (version ${version ?? "latest"}) not found in ${[
            projectName ?? projectId,
          ]} (not found on server or in local cache): ${e}`,
        );
      }
    }
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    return parameters as RemoteEvalParameters<true, true, InferParameters<S>>;
  }
  const { response } = result;

  if (!("objects" in response) || response.objects.length === 0) {
    if (id) {
      throw new Error(`Parameters with id ${id} not found.`);
    } else {
      throw new Error(
        `Parameters ${slug} not found in ${[projectName ?? projectId]}`,
      );
    }
  } else if (response.objects.length > 1) {
    if (id) {
      throw new Error(
        `Multiple parameters found with id ${id}. This should never happen.`,
      );
    } else {
      throw new Error(
        `Multiple parameters found with slug ${slug} in project ${
          projectName ?? projectId
        }. This should never happen.`,
      );
    }
  }

  const metadata = parametersRowSchema.parse(response["objects"][0]);
  const parameters = new RemoteEvalParameters(metadata);
  try {
    if (id) {
      await parametersCache.set({ id }, parameters);
    } else if (slug) {
      await parametersCache.set(
        { slug, projectId, projectName, version: version ?? "latest" },
        parameters,
      );
    }
  } catch (e) {
    debugLogger.forState(state).warn("Failed to set parameters in cache:", e);
  }
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return parameters as RemoteEvalParameters<true, true, InferParameters<S>>;
}

export type CompiledPromptResponseFormat =
  | { type: "json_object" }
  | { type: "text" }
  | {
      type: "json_schema";
      json_schema: {
        name: string;
        description?: string;
        schema?: Record<string, unknown>;
        strict?: boolean | null;
      };
    };

// Keep the compiled API independent of the backend's provider parameter union.
// "none" is excluded from reasoning_effort for compatibility with older OpenAI clients.
export interface CompiledPromptParams {
  chat_template_kwargs?: { enable_thinking?: boolean; [key: string]: unknown };
  model: string;
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  max_completion_tokens?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  response_format?: CompiledPromptResponseFormat;
  tool_choice?:
    | "auto"
    | "none"
    | "required"
    | {
        type: "function";
        function: { name: string };
      };
  function_call?: "auto" | "none" | { name: string };
  n?: number;
  stop?: string[];
  reasoning_effort?: "minimal" | "low" | "medium" | "high";
  verbosity?: "low" | "medium" | "high";
  top_k?: number;
  stop_sequences?: string[];
  reasoning_enabled?: boolean;
  reasoning_budget?: number;
  /** Legacy parameter; prefer max_tokens. */
  max_tokens_to_sample?: number;
  maxOutputTokens?: number;
  topP?: number;
  topK?: number;
}

export type ChatPrompt = {
  messages: OpenAIMessage[];
  tools?: ChatCompletionTool[];
};

export type CompletionPrompt = {
  prompt: string;
};

export type CompiledPrompt<Flavor extends "chat" | "completion"> =
  CompiledPromptParams & {
    span_info?: {
      name?: string;
      spanAttributes?: Record<any, any>;
      metadata: {
        prompt: {
          variables: Record<string, unknown>;
          id: string;
          project_id: string;
          version: string;
        };
      };
    };
  } & (Flavor extends "chat"
      ? ChatPrompt
      : Flavor extends "completion"
        ? CompletionPrompt
        : // eslint-disable-next-line @typescript-eslint/no-empty-object-type
          {});

export interface DefaultPromptArgs
  extends
    Partial<CompiledPromptParams>,
    Partial<ChatPrompt>,
    Partial<CompletionPrompt> {
  use_cache?: boolean;
}

function isAttachmentObject(value: unknown): boolean {
  return (
    BraintrustAttachmentReferenceSchema.safeParse(value).success ||
    InlineAttachmentReferenceSchema.safeParse(value).success ||
    ExternalAttachmentReferenceSchema.safeParse(value).success
  );
}

// Simple URL validation all braintrust attachment urls or generic links
function isURL(url: string): boolean {
  try {
    const parsedUrl = new URL(url.trim());
    return parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Detect and expand attachment array variables before template rendering.
 * Supports both simple variables ({{images}}) and nested paths ({{data.images}}).
 * @param content The message content (should be a template variable like "{{images}}" or "{{data.images}}")
 * @param variables The variables object with array values
 * @returns Array of image_url parts if expansion occurred, null otherwise
 */
function expandAttachmentArrayPreTemplate(
  content: unknown,
  variables: Record<string, unknown>,
): unknown[] | null {
  if (typeof content !== "string") return null;

  // Detect {{varName}} or {{nested.path}} pattern (exact match only - no mixed content)
  // Supports: {{images}}, {{data.images}}, {{user.profile.images}}, etc.
  const match = content.match(/^\{\{\s*([\w.]+)\s*\}\}$/);
  if (!match) return null;

  const varPath = match[1];

  const value = varPath.includes(".")
    ? getObjValueByPath(variables, varPath.split("."))
    : variables[varPath];

  if (!Array.isArray(value)) return null;

  // Check if array contains attachments or image URLs
  const allValid = value.every(
    (v) => isAttachmentObject(v) || (typeof v === "string" && isURL(v)),
  );

  if (!allValid) return null;

  // Expand directly to image_url parts
  return value.map((item) => ({
    type: "image_url" as const,
    image_url: { url: item },
  }));
}

export function renderMessageImpl<T extends Message>(
  render: (template: string) => string,
  message: T,
  variables?: Record<string, unknown>,
): T {
  return {
    ...message,
    ...("content" in message
      ? {
          content: isEmpty(message.content)
            ? undefined
            : typeof message.content === "string"
              ? render(message.content)
              : message.content.flatMap((c) => {
                  switch (c.type) {
                    case "text":
                      return [{ ...c, text: render(c.text) }];
                    case "image_url":
                      if (isObject(c.image_url.url)) {
                        throw new Error(
                          "Attachments must be replaced with URLs before calling `build()`",
                        );
                      }

                      if (variables) {
                        const expanded = expandAttachmentArrayPreTemplate(
                          c.image_url.url,
                          variables,
                        );
                        if (expanded) {
                          return expanded;
                        }
                      }

                      // Otherwise render the URL template normally
                      return [
                        {
                          ...c,
                          image_url: {
                            ...c.image_url,
                            url: render(c.image_url.url),
                          },
                        },
                      ];
                    case "input_audio":
                      return [
                        {
                          ...c,
                          input_audio: {
                            ...c.input_audio,
                            data: render(c.input_audio.data),
                          },
                        },
                      ];
                    case "file":
                      return [
                        {
                          ...c,
                          file: {
                            ...(c.file.file_data && {
                              file_data: render(c.file.file_data),
                            }),
                            ...(c.file.file_id && {
                              file_id: render(c.file.file_id),
                            }),
                            ...(c.file.filename && {
                              filename: render(c.file.filename),
                            }),
                          },
                        },
                      ];
                    default:
                      const _exhaustiveCheck: never = c;
                      return _exhaustiveCheck;
                  }
                }),
        }
      : {}),
    ...("tool_calls" in message
      ? {
          tool_calls: isEmpty(message.tool_calls)
            ? undefined
            : message.tool_calls.map((t) => {
                return {
                  type: t.type,
                  id: render(t.id),
                  function: {
                    name: render(t.function.name),
                    arguments: render(t.function.arguments),
                  },
                };
              }),
        }
      : {}),
    ...("tool_call_id" in message
      ? {
          tool_call_id: render(message.tool_call_id),
        }
      : {}),
  };
}

export interface PromptMetadata {
  name: string;
  slug: string;
  project_id?: string;
  description?: string | null;
  created?: string | null;
  prompt_data?: PromptData | null;
  tags?: string[] | null;
  // Preserve the generated prompt row's permissive metadata contract.
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  metadata?: {} | null;
  function_type?: FunctionTypeEnum | null;
}

export type PromptRowWithId<
  HasId extends boolean = true,
  HasVersion extends boolean = true,
> = PromptMetadata &
  (HasId extends true ? { id: string } : { id?: string }) &
  (HasVersion extends true ? { _xact_id: string } : { _xact_id?: string });

function deserializePlainStringAsJSON(
  s: string,
): { value: any; error: undefined } | { value: string; error: unknown } {
  if (s.trim() === "") {
    return { value: null, error: undefined };
  }

  try {
    return { value: JSON.parse(s), error: undefined };
  } catch (e) {
    return { value: s, error: e };
  }
}

function renderTemplatedObject(
  obj: unknown,
  args: Record<string, unknown>,
  options: { strict?: boolean; templateFormat: TemplateFormat },
): unknown {
  if (typeof obj === "string") {
    return renderTemplateContent(
      obj,
      args,
      (value) => (typeof value === "string" ? value : JSON.stringify(value)),
      {
        strict: options.strict,
        templateFormat: options.templateFormat,
      },
    );
  } else if (isArray(obj)) {
    return obj.map((item) => renderTemplatedObject(item, args, options));
  } else if (isObject(obj)) {
    return Object.fromEntries(
      Object.entries(obj).map(([key, value]) => [
        key,
        renderTemplatedObject(value, args, options),
      ]),
    );
  }
  return obj;
}

function renderPromptParams(
  params: ModelParams | undefined,
  args: Record<string, unknown>,
  options: { strict?: boolean; templateFormat?: TemplateFormat } = {},
): ModelParams | undefined {
  const templateFormat = parseTemplateFormat(options.templateFormat);
  const strict = !!options.strict;

  const schemaParsed = z
    .object({
      response_format: z.object({
        type: z.literal("json_schema"),
        json_schema: z.object({
          name: z.string(),
          description: z.string().optional(),
          strict: z.boolean().nullable().optional(),
          schema: z.unknown(),
        }),
      }),
    })
    .safeParse(params);
  if (schemaParsed.success) {
    const rawSchema = schemaParsed.data.response_format.json_schema.schema;
    const templatedSchema = renderTemplatedObject(rawSchema, args, {
      strict,
      templateFormat,
    });
    const parsedSchema =
      typeof templatedSchema === "string"
        ? deserializePlainStringAsJSON(templatedSchema).value
        : templatedSchema;

    return {
      ...params,
      response_format: {
        ...schemaParsed.data.response_format,
        json_schema: {
          ...schemaParsed.data.response_format.json_schema,
          schema: parsedSchema,
        },
      },
    };
  }
  return params;
}

export interface SerializedPrompt {
  metadata: PromptRowWithId | PromptSessionEvent;
  defaults: DefaultPromptArgs;
  noTrace: boolean;
}

// Initialized by the class so cache serialization can access private fields
// without exposing a serialization method on the public Prompt API.
export let serializePromptForCache: (prompt: Prompt) => SerializedPrompt;

export class Prompt<
  HasId extends boolean = true,
  HasVersion extends boolean = true,
> {
  private parsedPromptData: PromptData | undefined;
  private hasParsedPromptData = false;
  private readonly __braintrust_prompt_marker = true;

  constructor(
    private metadata: PromptRowWithId<HasId, HasVersion> | PromptSessionEvent,
    private defaults: DefaultPromptArgs,
    private noTrace: boolean,
  ) {
    void this.__braintrust_prompt_marker;
  }

  public get id(): HasId extends true ? string : string | undefined {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    return this.metadata.id as HasId extends true ? string : string | undefined;
  }

  public get projectId(): string | undefined {
    return this.metadata.project_id;
  }

  public get name(): string {
    return "name" in this.metadata
      ? this.metadata.name
      : `Playground function ${this.metadata.id}`;
  }

  public get slug(): string {
    return "slug" in this.metadata ? this.metadata.slug : this.metadata.id;
  }

  public get prompt(): PromptData["prompt"] {
    return this.getParsedPromptData()?.prompt;
  }

  public get version(): HasId extends true
    ? TransactionId
    : TransactionId | undefined {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    return this.metadata[TRANSACTION_ID_FIELD] as HasId extends true
      ? TransactionId
      : TransactionId | undefined;
  }

  public get options(): NonNullable<PromptData["options"]> {
    return this.getParsedPromptData()?.options || {};
  }

  public get templateFormat(): string | null | undefined {
    return this.getParsedPromptData()?.template_format;
  }

  public get promptData(): PromptData {
    return this.getParsedPromptData()!;
  }

  /**
   * Build the prompt with the given formatting options. The args you pass in will
   * be forwarded to the mustache template that defines the prompt and rendered with
   * the `mustache-js` library.
   *
   * @param buildArgs Args to forward along to the prompt template.
   */
  public build<Flavor extends "chat" | "completion" = "chat">(
    buildArgs: unknown,
    options: {
      flavor?: Flavor;
      messages?: Message[];
      strict?: boolean;
      templateFormat?: TemplateFormat;
    } = {},
  ): CompiledPrompt<Flavor> {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    return this.runBuild(buildArgs, {
      flavor: options.flavor ?? "chat",
      messages: options.messages,
      strict: options.strict,
      templateFormat: options.templateFormat,
    }) as CompiledPrompt<Flavor>;
  }

  /**
   * This is a special build method that first resolves attachment references, and then
   * calls the regular build method. You should use this if you are building prompts from
   * dataset rows that contain attachments.
   *
   * @param buildArgs Args to forward along to the prompt template.
   */
  public async buildWithAttachments<
    Flavor extends "chat" | "completion" = "chat",
  >(
    buildArgs: unknown,
    options: {
      flavor?: Flavor;
      messages?: Message[];
      strict?: boolean;
      state?: BraintrustState;
      templateFormat?: TemplateFormat;
    } = {},
  ): Promise<CompiledPrompt<Flavor>> {
    const hydrated =
      buildArgs instanceof Object
        ? await resolveAttachmentsToBase64(buildArgs, options.state)
        : buildArgs;
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    return this.runBuild(hydrated, {
      flavor: options.flavor ?? "chat",
      messages: options.messages,
      strict: options.strict,
      templateFormat: options.templateFormat,
    }) as CompiledPrompt<Flavor>;
  }

  private runBuild<Flavor extends "chat" | "completion">(
    buildArgs: unknown,
    options: {
      flavor: Flavor;
      messages?: Message[];
      strict?: boolean;
      templateFormat?: TemplateFormat;
    },
  ): CompiledPrompt<Flavor> {
    const { flavor } = options;

    const params = Object.fromEntries(
      Object.entries({
        ...this.defaults,
        ...Object.fromEntries(
          Object.entries(this.options.params || {}).filter(
            ([k, _v]) => !BRAINTRUST_PARAMS.includes(k),
          ),
        ),
        ...(!isEmpty(this.options.model)
          ? {
              model: this.options.model,
            }
          : {}),
      }).filter(([key, value]) => key !== "response_format" || value !== null),
    );

    if (!("model" in params) || isEmpty(params.model)) {
      throw new Error(
        "No model specified. Either specify it in the prompt or as a default",
      );
    }

    const spanInfo = this.noTrace
      ? {}
      : {
          span_info: {
            metadata: {
              prompt: this.id
                ? {
                    variables: buildArgs,
                    id: this.id,
                    project_id: this.projectId,
                    version: this.version,
                    ...("prompt_session_id" in this.metadata
                      ? { prompt_session_id: this.metadata.prompt_session_id }
                      : {}),
                  }
                : undefined,
            },
          },
        };

    const prompt = this.prompt;

    if (!prompt) {
      throw new Error("Empty prompt");
    }

    const dictArgParsed = z.record(z.unknown()).safeParse(buildArgs);
    const variables: Record<string, unknown> = {
      input: buildArgs,
      ...(dictArgParsed.success ? dictArgParsed.data : {}),
    };

    // Use template_format from prompt data if available, otherwise fall back to the option or default to mustache
    const promptDataTemplateFormat = this.templateFormat;
    const resolvedTemplateFormat = parseTemplateFormat(
      options.templateFormat ?? promptDataTemplateFormat,
    );

    const renderedPrompt = Prompt.renderPrompt({
      prompt,
      buildArgs,
      options: { ...options, templateFormat: resolvedTemplateFormat },
    });

    if (flavor === "chat") {
      if (renderedPrompt.type !== "chat") {
        throw new Error(
          "Prompt is a completion prompt. Use buildCompletion() instead",
        );
      }

      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      return {
        ...renderPromptParams(params, variables, {
          strict: options.strict,
          templateFormat: resolvedTemplateFormat,
        }),
        ...spanInfo,
        messages: renderedPrompt.messages,
        ...(renderedPrompt.tools
          ? {
              tools: chatCompletionToolSchema
                .array()
                .parse(JSON.parse(renderedPrompt.tools)),
            }
          : undefined),
      } as CompiledPrompt<Flavor>;
    } else if (flavor === "completion") {
      if (renderedPrompt.type !== "completion") {
        throw new Error(`Prompt is a chat prompt. Use flavor: 'chat' instead`);
      }

      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      return {
        ...renderPromptParams(params, variables, {
          strict: options.strict,
          templateFormat: resolvedTemplateFormat,
        }),
        ...spanInfo,
        prompt: renderedPrompt.content,
      } as CompiledPrompt<Flavor>;
    } else {
      throw new Error("never!");
    }
  }

  static renderPrompt({
    prompt,
    buildArgs,
    options,
  }: {
    prompt: PromptBlockData;
    buildArgs: unknown;
    options: {
      strict?: boolean;
      messages?: Message[];
      templateFormat?: TemplateFormat;
    };
  }): PromptBlockData {
    const escape = (v: unknown) => {
      if (v === undefined) {
        throw new Error("Missing!");
      } else if (typeof v === "string") {
        return v;
      } else if (v instanceof ReadonlyAttachment) {
        throw new Error(
          "Use buildWithAttachments() to build prompts with attachments",
        );
      } else {
        return JSON.stringify(v);
      }
    };

    const dictArgParsed = z.record(z.unknown()).safeParse(buildArgs);
    const variables: Record<string, unknown> = {
      input: buildArgs,
      ...(dictArgParsed.success ? dictArgParsed.data : {}),
    };

    const templateFormat = parseTemplateFormat(options.templateFormat);

    if (prompt.type === "chat") {
      const render = (template: string) =>
        renderTemplateContent(template, variables, escape, {
          strict: options.strict,
          templateFormat: templateFormat,
        });

      const baseMessages = (prompt.messages || []).map((m) =>
        renderMessageImpl(render, m, variables),
      );
      const hasSystemPrompt = baseMessages.some((m) => m.role === "system");

      const messages: Message[] = [
        ...baseMessages,
        ...(options.messages ?? []).filter(
          (m) => !(hasSystemPrompt && m.role === "system"),
        ),
      ];

      return {
        type: "chat",
        messages: messages,
        ...(prompt.tools?.trim()
          ? {
              tools: render(prompt.tools),
            }
          : undefined),
      };
    } else if (prompt.type === "completion") {
      if (options.messages) {
        throw new Error(
          "extra messages are not supported for completion prompts",
        );
      }

      const content = renderTemplateContent(prompt.content, variables, escape, {
        strict: options.strict,
        templateFormat: templateFormat,
      });
      return {
        type: "completion",
        content,
      };
    } else {
      const _: never = prompt;
      throw new Error(`Invalid prompt type: ${_}`);
    }
  }

  private getParsedPromptData(): PromptData | undefined {
    if (!this.hasParsedPromptData) {
      this.parsedPromptData = promptDataSchema.parse(this.metadata.prompt_data);
      this.hasParsedPromptData = true;
    }
    return this.parsedPromptData!;
  }

  public static isPrompt(data: unknown): data is Prompt<boolean, boolean> {
    return (
      typeof data === "object" &&
      data !== null &&
      "__braintrust_prompt_marker" in data
    );
  }

  static {
    serializePromptForCache = (prompt) => ({
      metadata: prompt.metadata,
      defaults: prompt.defaults,
      noTrace: prompt.noTrace,
    });
  }

  public static fromPromptData(
    name: string,
    promptData: PromptData,
  ): Prompt<false, false> {
    return new Prompt(
      {
        name: name,
        slug: name,
        prompt_data: promptData,
      },
      {},
      false,
    );
  }
}

export interface SerializedParameters {
  metadata: ParametersRow;
}

export let serializeParametersForCache: (
  parameters: RemoteEvalParameters,
) => SerializedParameters;

export class RemoteEvalParameters<
  HasId extends boolean = true,
  HasVersion extends boolean = true,
  T extends Record<string, unknown> = Record<string, unknown>,
> {
  private readonly __braintrust_parameters_marker = true;

  constructor(private metadata: ParametersRow) {
    void this.__braintrust_parameters_marker;
  }

  public get id(): HasId extends true ? string : string | undefined {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    return this.metadata.id as HasId extends true ? string : string | undefined;
  }

  public get projectId(): string | undefined {
    return this.metadata.project_id;
  }

  public get name(): string {
    return this.metadata.name;
  }

  public get slug(): string {
    return this.metadata.slug;
  }

  public get version(): HasVersion extends true
    ? TransactionId
    : TransactionId | undefined {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    return this.metadata[TRANSACTION_ID_FIELD] as HasVersion extends true
      ? TransactionId
      : TransactionId | undefined;
  }

  public get schema(): Record<string, unknown> {
    return this.metadata.function_data.__schema;
  }

  public get data(): T {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    return (this.metadata.function_data.data ?? {}) as T;
  }

  static {
    serializeParametersForCache = (parameters) => ({
      metadata: parameters.metadata,
    });
  }

  public validate(data: unknown): boolean {
    if (typeof data !== "object" || data === null) {
      return false;
    }
    const schemaProps = this.schema.properties;
    if (typeof schemaProps !== "object" || schemaProps === null) {
      return true;
    }
    for (const key of Object.keys(schemaProps)) {
      if (!(key in data)) {
        const required = Array.isArray(this.schema.required)
          ? this.schema.required
          : [];
        if (required.includes(key)) {
          return false;
        }
      }
    }
    return true;
  }

  public static isParameters(
    x: unknown,
  ): x is RemoteEvalParameters<boolean, boolean, Record<string, unknown>> {
    return (
      typeof x === "object" &&
      x !== null &&
      "__braintrust_parameters_marker" in x &&
      x.__braintrust_parameters_marker === true
    );
  }
}

/**
 * Get the versions for a prompt.
 *
 * @param projectId The ID of the project to query
 * @param promptId The ID of the prompt to get versions for
 * @returns Promise containing the version data
 */
export async function getPromptVersions(
  projectId: string,
  promptId: string,
): Promise<any> {
  const state = _internalGetGlobalState();
  if (!state) {
    throw new Error("Must log in first");
  }

  await state.login({});

  const query = {
    from: {
      op: "function",
      name: {
        op: "ident",
        name: ["project_prompts"],
      },
      args: [
        {
          op: "literal",
          value: projectId,
        },
      ],
    },
    select: [
      {
        op: "star",
      },
    ],
    filter: {
      op: "eq",
      left: { op: "ident", name: ["id"] },
      right: { op: "literal", value: promptId },
    },
  };

  const response = await state.apiConn().post(
    "btql",
    {
      query,
      audit_log: true,
      use_columnstore: false,
      brainstore_realtime: true,
    },
    { headers: { "Accept-Encoding": "gzip" } },
    BTQL_HTTP_RETRIES,
  );

  if (!response.ok) {
    throw new Error(
      `API request failed: ${response.status} ${response.statusText}`,
    );
  }

  const result = await response.json();

  // Filter for entries where audit_data.action is "upsert" or "merge" and return only _xact_id fields
  return (
    result.data
      ?.filter((entry: any) =>
        ["upsert", "merge"].includes(entry.audit_data?.action),
      )
      .map((entry: any) => prettifyXact(entry._xact_id)) || []
  );
}

interface LoaderCacheViews {
  promptCache: PromptCache;
  parametersCache: ParametersCache;
}

const loaderCaches = /* @__PURE__ */ new WeakMap<
  BraintrustState,
  LoaderCacheViews
>();

/** @internal Caches belong to prompt/parameter loading, not tracing state. */
export function getLoaderCaches(state: BraintrustState): LoaderCacheViews {
  let caches = loaderCaches.get(state);
  if (!caches) {
    const { memoryCache, diskCache } = createCacheLayers<
      PromptMemoryCacheEntry,
      PromptDiskCacheEntry
    >({
      memoryMaxEnvVar: "BRAINTRUST_PROMPT_CACHE_MEMORY_MAX",
      diskCacheDirEnvVar: "BRAINTRUST_PROMPT_CACHE_DIR",
      diskMaxEnvVar: "BRAINTRUST_PROMPT_CACHE_DISK_MAX",
      getDefaultDiskCacheDir: () =>
        `${iso.getEnv("HOME") ?? iso.homedir!()}/.braintrust/prompt_cache`,
    });
    const promptCache = new PromptCache({ memoryCache, diskCache });

    const {
      memoryCache: parametersMemoryCache,
      diskCache: parametersDiskCache,
    } = createCacheLayers<ParametersMemoryCacheEntry, ParametersDiskCacheEntry>(
      {
        memoryMaxEnvVar: "BRAINTRUST_PARAMETERS_CACHE_MEMORY_MAX",
        diskCacheDirEnvVar: "BRAINTRUST_PARAMETERS_CACHE_DIR",
        diskMaxEnvVar: "BRAINTRUST_PARAMETERS_CACHE_DISK_MAX",
        getDefaultDiskCacheDir: () =>
          `${iso.getEnv("HOME") ?? iso.homedir!()}/.braintrust/parameters_cache`,
      },
    );
    const parametersCache = new ParametersCache({
      memoryCache: parametersMemoryCache,
      diskCache: parametersDiskCache,
    });

    caches = { promptCache, parametersCache };
    loaderCaches.set(state, caches);
  }
  return caches;
}

function getLoaderCacheViews(
  state: BraintrustState,
  loginOptions: ResolvedLoaderLoginOptions,
  requestState?: LoaderRequestState,
): LoaderCacheViews {
  const caches = getLoaderCaches(state);

  const expectedResolvedOrgIdentity =
    requestState?.orgId && requestState.appUrl
      ? JSON.stringify(["loader-org", requestState.appUrl, requestState.orgId])
      : undefined;

  return {
    promptCache: caches.promptCache.withNamespace(
      loginOptions.credentialCacheNamespace,
      expectedResolvedOrgIdentity,
    ),
    parametersCache: caches.parametersCache.withNamespace(
      loginOptions.credentialCacheNamespace,
      expectedResolvedOrgIdentity,
    ),
  };
}
