/**
 * Runtime validators for the SDK-owned subset of the Braintrust API.
 * Input/output type compatibility is checked in sdk-contracts.test.ts.
 */
import { z } from "zod/v3";
import type * as SDK from "./sdk-types";

const ResponseFormatJsonSchema: z.ZodType<SDK.ResponseFormatJsonSchema> =
  /* @__PURE__ */ (() =>
    z.object({
      name: z.string(),
      description: z.string().optional(),
      schema: z
        .union([z.object({}).partial().passthrough(), z.string()])
        .optional(),
      strict: z.union([z.boolean(), z.null()]).optional(),
    }))();

const ResponseFormatNullish = /* @__PURE__ */ (() =>
  z.union([
    z.object({ type: z.literal("json_object") }),
    z.object({
      type: z.literal("json_schema"),
      json_schema: ResponseFormatJsonSchema,
    }),
    z.object({ type: z.literal("text") }),
    z.null(),
  ]))();

const BraintrustAttachmentReferenceObject = /* @__PURE__ */ (() =>
  z.object({
    type: z.literal("braintrust_attachment"),
    filename: z.string().min(1),
    content_type: z.string().min(1),
    key: z.string().min(1),
  }))();

const ExternalAttachmentReferenceObject = /* @__PURE__ */ (() =>
  z.object({
    type: z.literal("external_attachment"),
    filename: z.string().min(1),
    content_type: z.string().min(1),
    url: z.string().min(1),
  }))();

export const AttachmentReference: z.ZodType<SDK.AttachmentReference> =
  /* @__PURE__ */ (() =>
    z.discriminatedUnion("type", [
      BraintrustAttachmentReferenceObject,
      ExternalAttachmentReferenceObject,
    ]))();

const UploadStatus = /* @__PURE__ */ (() =>
  z.enum(["uploading", "done", "error"]))();

export const AttachmentStatus: z.ZodType<SDK.AttachmentStatus> =
  /* @__PURE__ */ (() =>
    z.object({
      upload_status: UploadStatus,
      error_message: z.string().optional(),
    }))();

const FunctionTypeEnum = /* @__PURE__ */ (() =>
  z.enum([
    "llm",
    "scorer",
    "task",
    "tool",
    "custom_view",
    "preprocessor",
    "facet",
    "classifier",
    "tag",
    "parameters",
    "sandbox",
  ]))();

const SavedFunctionId = /* @__PURE__ */ (() =>
  z.union([
    z.object({
      type: z.literal("function"),
      id: z.string(),
      version: z.string().optional(),
    }),
    z.object({
      type: z.literal("global"),
      name: z.string(),
      function_type: FunctionTypeEnum.optional().default("scorer"),
    }),
  ]))();

const BraintrustModelParamsObject = /* @__PURE__ */ (() =>
  z
    .object({
      use_cache: z.boolean(),
      reasoning_enabled: z.boolean(),
      reasoning_budget: z.number(),
    })
    .partial())();

export const CallEvent: z.ZodType<SDK.CallEvent> = /* @__PURE__ */ (() =>
  z.union([
    z.object({
      id: z.string().optional(),
      data: z.string(),
      event: z.literal("text_delta"),
    }),
    z.object({
      id: z.string().optional(),
      data: z.string(),
      event: z.literal("reasoning_delta"),
    }),
    z.object({
      id: z.string().optional(),
      data: z.string(),
      event: z.literal("json_delta"),
    }),
    z.object({
      id: z.string().optional(),
      data: z.string(),
      event: z.literal("progress"),
    }),
    z.object({
      id: z.string().optional(),
      data: z.string(),
      event: z.literal("error"),
    }),
    z.object({
      id: z.string().optional(),
      data: z.string(),
      event: z.literal("console"),
    }),
    z.object({
      id: z.string().optional(),
      event: z.literal("start"),
      data: z.literal(""),
    }),
    z.object({
      id: z.string().optional(),
      event: z.literal("done"),
      data: z.literal(""),
    }),
  ]))();

const CacheControl = /* @__PURE__ */ (() =>
  z.object({
    type: z.literal("ephemeral"),
    ttl: z.enum(["5m", "1h"]).optional(),
  }))();

const ChatCompletionContentPartText = /* @__PURE__ */ (() =>
  z.object({
    text: z.string().default(""),
    type: z.literal("text"),
    cache_control: CacheControl.optional(),
  }))();

const ChatCompletionContentPartImageWithTitle = /* @__PURE__ */ (() =>
  z.object({
    image_url: z.object({
      url: z.string(),
      detail: z
        .union([z.literal("auto"), z.literal("low"), z.literal("high")])
        .optional(),
    }),
    type: z.literal("image_url"),
    cache_control: CacheControl.optional(),
  }))();

const ChatCompletionContentPartFileFile = /* @__PURE__ */ (() =>
  z
    .object({
      file_data: z.string(),
      filename: z.string(),
      file_id: z.string(),
    })
    .partial())();

const ChatCompletionContentPartFileWithTitle = /* @__PURE__ */ (() =>
  z.object({
    file: ChatCompletionContentPartFileFile,
    type: z.literal("file"),
    cache_control: CacheControl.optional(),
  }))();

const ChatCompletionContentPartInputAudioWithTitle = /* @__PURE__ */ (() =>
  z.object({
    input_audio: z.object({ data: z.string(), format: z.enum(["wav", "mp3"]) }),
    type: z.literal("input_audio"),
    cache_control: CacheControl.optional(),
  }))();
const ChatCompletionContentPart = /* @__PURE__ */ (() =>
  z.union([
    ChatCompletionContentPartText,
    ChatCompletionContentPartImageWithTitle,
    ChatCompletionContentPartInputAudioWithTitle,
    ChatCompletionContentPartFileWithTitle,
  ]))();

const ChatCompletionMessageToolCall = /* @__PURE__ */ (() =>
  z.object({
    id: z.string(),
    function: z.object({ arguments: z.string(), name: z.string() }),
    type: z.literal("function"),
  }))();

const ChatCompletionMessageReasoning = /* @__PURE__ */ (() =>
  z.object({ id: z.string(), content: z.string() }).partial())();

const ChatCompletionMessageParam = /* @__PURE__ */ (() =>
  z.union([
    z.object({
      content: z.union([z.string(), z.array(ChatCompletionContentPartText)]),
      role: z.literal("system"),
      name: z.string().optional(),
    }),
    z.object({
      content: z.union([z.string(), z.array(ChatCompletionContentPart)]),
      role: z.literal("user"),
      name: z.string().optional(),
    }),
    z.object({
      role: z.literal("assistant"),
      content: z
        .union([z.string(), z.array(ChatCompletionContentPartText), z.null()])
        .optional(),
      function_call: z
        .object({ arguments: z.string(), name: z.string() })
        .optional(),
      name: z.string().optional(),
      tool_calls: z.array(ChatCompletionMessageToolCall).optional(),
      reasoning: z.array(ChatCompletionMessageReasoning).optional(),
      reasoning_signature: z.string().optional(),
    }),
    z.object({
      content: z.union([z.string(), z.array(ChatCompletionContentPartText)]),
      role: z.literal("tool"),
      tool_call_id: z.string().default(""),
    }),
    z.object({
      content: z.union([z.string(), z.null()]),
      name: z.string(),
      role: z.literal("function"),
    }),
    z.object({
      content: z.union([z.string(), z.array(ChatCompletionContentPartText)]),
      role: z.literal("developer"),
      name: z.string().optional(),
    }),
    z.object({
      role: z.literal("model"),
      content: z.union([z.string(), z.null()]).optional(),
    }),
  ]))();

export const ChatCompletionTool: z.ZodType<SDK.ChatCompletionTool> =
  /* @__PURE__ */ (() =>
    z.object({
      function: z.object({
        name: z.string(),
        description: z.string().optional(),
        parameters: z.object({}).partial().passthrough().optional(),
      }),
      type: z.literal("function"),
    }))();

export const ObjectReference: z.ZodType<SDK.ObjectReference> =
  /* @__PURE__ */ (() =>
    z.object({
      object_type: z.enum([
        "project_logs",
        "experiment",
        "dataset",
        "prompt",
        "function",
        "prompt_session",
      ]),
      object_id: z.string().uuid(),
      id: z.string(),
      _xact_id: z.union([z.string(), z.null()]).optional(),
      created: z.union([z.string(), z.null()]).optional(),
    }))();

export const DatasetSnapshot: z.ZodType<SDK.DatasetSnapshot> =
  /* @__PURE__ */ (() =>
    z.object({
      id: z.string().uuid(),
      dataset_id: z.string().uuid(),
      name: z.string(),
      description: z.union([z.string(), z.null()]),
      xact_id: z.string(),
      created: z.union([z.string(), z.null()]),
    }))();

const PromptBlockDataNullish = /* @__PURE__ */ (() =>
  z.union([
    z.object({
      type: z.literal("chat"),
      messages: z.array(ChatCompletionMessageParam),
      tools: z.string().optional(),
    }),
    z.object({ type: z.literal("completion"), content: z.string() }),
    z.null(),
  ]))();

const ModelParams = /* @__PURE__ */ (() =>
  z.union([
    BraintrustModelParamsObject.extend({
      temperature: z.number(),
      top_p: z.number(),
      max_tokens: z.number(),
      max_completion_tokens: z.number(),
      frequency_penalty: z.number(),
      presence_penalty: z.number(),
      response_format: ResponseFormatNullish,
      tool_choice: z.union([
        z.literal("auto"),
        z.literal("none"),
        z.literal("required"),
        z.object({
          type: z.literal("function"),
          function: z.object({ name: z.string() }),
        }),
      ]),
      function_call: z.union([
        z.literal("auto"),
        z.literal("none"),
        z.object({ name: z.string() }),
      ]),
      n: z.number(),
      stop: z.array(z.string()),
      chat_template_kwargs: z
        .object({ enable_thinking: z.boolean() })
        .partial()
        .passthrough(),
      reasoning_effort: z.enum(["none", "minimal", "low", "medium", "high"]),
      verbosity: z.enum(["low", "medium", "high"]),
    })
      .partial()
      .passthrough(),
    BraintrustModelParamsObject.extend({
      max_tokens: z.number(),
      temperature: z.number(),
      top_p: z.number().optional(),
      top_k: z.number().optional(),
      stop_sequences: z.array(z.string()).optional(),
      max_tokens_to_sample: z.number().optional(),
    }).passthrough(),
    BraintrustModelParamsObject.extend({
      temperature: z.number(),
      maxOutputTokens: z.number(),
      topP: z.number(),
      topK: z.number(),
    })
      .partial()
      .passthrough(),
    BraintrustModelParamsObject.extend({
      temperature: z.number(),
      topK: z.number(),
    })
      .partial()
      .passthrough(),
    BraintrustModelParamsObject.passthrough(),
  ]))();

const PromptOptionsNullish = /* @__PURE__ */ (() =>
  z.union([
    z
      .object({
        model: z.string(),
        params: ModelParams,
        position: z.string(),
        endpoint_name: z.union([z.string(), z.null()]),
      })
      .partial(),
    z.null(),
  ]))();

const PromptParserNullish = /* @__PURE__ */ (() =>
  z.union([
    z.object({
      type: z.literal("llm_classifier"),
      use_cot: z.boolean(),
      choice_scores: z.record(z.number().gte(0).lte(1)).optional(),
      choice: z.array(z.string()).optional(),
      allow_no_match: z.boolean().optional(),
      allow_skip: z.boolean().optional(),
    }),
    z.null(),
  ]))();

const PreprocessorId = /* @__PURE__ */ (() =>
  z.union([
    z.object({
      type: z.literal("function"),
      id: z.string(),
      version: z.string().optional(),
    }),
    z.object({
      type: z.literal("global"),
      name: z.string(),
      function_type: z
        .literal("preprocessor")
        .optional()
        .default("preprocessor"),
    }),
    z.object({ type: z.literal("inline"), code: z.string().min(1) }),
    z.null(),
  ]))();

const FunctionFormat = /* @__PURE__ */ (() =>
  z.enum(["llm", "code", "global", "graph", "topic_map"]))();

export const PromptData: z.ZodType<
  SDK.PromptData,
  z.ZodTypeDef,
  SDK.SchemaInput<SDK.PromptData>
> = /* @__PURE__ */ (() =>
  z
    .object({
      prompt: PromptBlockDataNullish,
      options: PromptOptionsNullish,
      parser: PromptParserNullish,
      preprocessor: PreprocessorId,
      tool_functions: z.union([z.array(SavedFunctionId), z.null()]),
      template_format: z.union([
        z.enum(["mustache", "nunjucks", "none"]),
        z.null(),
      ]),
      mcp: z.union([
        z.record(
          z.union([
            z.object({
              type: z.literal("id"),
              id: z.string().uuid(),
              is_disabled: z.boolean().optional(),
              enabled_tools: z
                .union([z.array(z.string()), z.null()])
                .optional(),
            }),
            z.object({
              type: z.literal("url"),
              url: z.string(),
              is_disabled: z.boolean().optional(),
              enabled_tools: z
                .union([z.array(z.string()), z.null()])
                .optional(),
            }),
          ]),
        ),
        z.null(),
      ]),
      origin: z.union([
        z
          .object({
            prompt_id: z.string(),
            project_id: z.string(),
            prompt_version: z.string(),
          })
          .partial(),
        z.null(),
      ]),
    })
    .partial())();

export const FunctionId: z.ZodType<
  SDK.FunctionId,
  z.ZodTypeDef,
  SDK.SchemaInput<SDK.FunctionId>
> = /* @__PURE__ */ (() =>
  z.union([
    z.object({ function_id: z.string(), version: z.string().optional() }),
    z.object({
      project_name: z.string(),
      slug: z.string(),
      version: z.string().optional(),
    }),
    z.object({
      global_function: z.string(),
      function_type: FunctionTypeEnum.optional().default("scorer"),
    }),
    z.object({
      prompt_session_id: z.string(),
      prompt_session_function_id: z.string(),
      version: z.string().optional(),
    }),
    z.object({
      inline_context: z.object({
        runtime: z.enum(["node", "python", "browser", "quickjs"]),
        version: z.string(),
      }),
      code: z.string(),
      function_type: FunctionTypeEnum.and(z.unknown()).optional(),
      name: z.union([z.string(), z.null()]).optional(),
    }),
    z.object({
      inline_prompt: PromptData.optional(),
      inline_function: z.object({}).partial().passthrough(),
      function_type: FunctionTypeEnum.optional().default("scorer"),
      name: z.union([z.string(), z.null()]).optional(),
    }),
    z.object({
      inline_prompt: PromptData,
      function_type: FunctionTypeEnum.optional().default("scorer"),
      name: z.union([z.string(), z.null()]).optional(),
    }),
  ]))();

const FunctionObjectType = /* @__PURE__ */ (() =>
  z.enum([
    "prompt",
    "tool",
    "scorer",
    "task",
    "workflow",
    "custom_view",
    "preprocessor",
    "facet",
    "classifier",
    "parameters",
    "sandbox",
  ]))();

const FunctionOutputType = /* @__PURE__ */ (() =>
  z.enum(["completion", "score", "facet", "classification", "any"]))();

export const GitMetadataSettings: z.ZodType<SDK.GitMetadataSettings> =
  /* @__PURE__ */ (() =>
    z.object({
      collect: z.enum(["all", "none", "some"]),
      fields: z
        .array(
          z.enum([
            "commit",
            "branch",
            "tag",
            "dirty",
            "author_name",
            "author_email",
            "commit_message",
            "commit_time",
            "git_diff",
          ]),
        )
        .optional(),
    }))();

const ProjectSettings = /* @__PURE__ */ (() =>
  z.union([
    z
      .object({
        comparison_key: z.union([z.string(), z.null()]),
        baseline_experiment_id: z.union([z.string(), z.null()]),
        spanFieldOrder: z.union([
          z.array(
            z.object({
              object_type: z.string(),
              column_id: z.string(),
              position: z.string(),
              layout: z
                .union([z.literal("full"), z.literal("two_column"), z.null()])
                .optional(),
            }),
          ),
          z.null(),
        ]),
        remote_eval_sources: z.union([
          z.array(
            z.object({
              url: z.string(),
              name: z.union([z.string(), z.null()]).optional(),
              description: z.union([z.string(), z.null()]).optional(),
            }),
          ),
          z.null(),
        ]),
        disable_realtime_queries: z.union([z.boolean(), z.null()]),
        monitor_charts_use_metrics_start: z.union([z.boolean(), z.null()]),
        coding_agent_insights_dashboard: z.union([z.boolean(), z.null()]),
        require_all_human_review_scores: z.union([z.boolean(), z.null()]),
        blind_reviews: z.union([z.boolean(), z.null()]),
        default_preprocessor: z.union([...SavedFunctionId.options, z.null()]),
      })
      .partial(),
    z.null(),
  ]))();

export const Project: z.ZodType<
  SDK.ProjectRecord,
  z.ZodTypeDef,
  SDK.SchemaInput<SDK.ProjectRecord>
> = /* @__PURE__ */ (() =>
  z.object({
    id: z.string().uuid(),
    org_id: z.string().uuid(),
    name: z.string(),
    description: z.union([z.string(), z.null()]).optional(),
    created: z.union([z.string(), z.null()]).optional(),
    deleted_at: z.union([z.string(), z.null()]).optional(),
    user_id: z.union([z.string(), z.null()]).optional(),
    settings: ProjectSettings.optional(),
  }))();

export const Prompt: z.ZodType<
  SDK.PromptRecord,
  z.ZodTypeDef,
  SDK.SchemaInput<SDK.PromptRecord>
> = /* @__PURE__ */ (() =>
  z.object({
    id: z.string().uuid(),
    _xact_id: z.string(),
    project_id: z.string().uuid(),
    log_id: z.literal("p"),
    org_id: z.string().uuid(),
    name: z.string(),
    slug: z.string(),
    description: z.union([z.string(), z.null()]).optional(),
    created: z.union([z.string(), z.null()]).optional(),
    prompt_data: z.union([PromptData, z.null()]).optional(),
    tags: z.union([z.array(z.string()), z.null()]).optional(),
    metadata: z
      .union([z.object({}).partial().passthrough(), z.null()])
      .optional(),
    function_type: z.union([FunctionTypeEnum, z.null()]).optional(),
  }))();

export const SSEConsoleEventData: z.ZodType<SDK.SSEConsoleEventData> =
  /* @__PURE__ */ (() =>
    z.object({
      stream: z.enum(["stderr", "stdout"]),
      message: z.string(),
    }))();

export const SSEProgressEventData: z.ZodType<SDK.SSEProgressEventData> =
  /* @__PURE__ */ (() =>
    z.object({
      id: z.string(),
      object_type: FunctionObjectType,
      origin: z.union([ObjectReference, z.null()]).and(z.unknown()).optional(),
      format: FunctionFormat,
      output_type: FunctionOutputType,
      name: z.string(),
      event: z.enum([
        "reasoning_delta",
        "text_delta",
        "json_delta",
        "error",
        "console",
        "start",
        "done",
        "progress",
      ]),
      data: z.string(),
    }))();

export const BraintrustAttachmentReference: z.ZodType<SDK.BraintrustAttachmentReference> =
  BraintrustAttachmentReferenceObject;

export const ExternalAttachmentReference: z.ZodType<SDK.ExternalAttachmentReference> =
  ExternalAttachmentReferenceObject;
