/* eslint-disable @typescript-eslint/no-empty-object-type -- Preserve the existing wire contracts, including permissive JSON fields. */
/* eslint-disable @typescript-eslint/no-explicit-any -- Provider parameter maps intentionally accept arbitrary values. */
/**
 * SDK-owned wire contracts. Keep backend-generated definitions in compatibility
 * tests only; changes here should describe the fields the SDK actually uses.
 */
export interface ResponseFormatJsonSchema {
  name: string;
  description?: string | undefined;
  schema?: ({} | string) | undefined;
  strict?: (boolean | null) | undefined;
}
export type ResponseFormatNullish =
  | {
      type: "json_object";
    }
  | {
      type: "json_schema";
      json_schema: ResponseFormatJsonSchema;
    }
  | {
      type: "text";
    }
  | null;
export type AsyncScoringState =
  | {
      status: "enabled";
      token: string;
      function_ids: Array<unknown>;
      skip_logging?: (boolean | null) | undefined;
      triggered_functions?: ({} | null) | undefined;
      last_triggered_xact_id?: (string | number | null) | undefined;
    }
  | {
      status: "disabled";
    }
  | null;
export type AsyncScoringControl =
  | {
      kind: "score_update";
      token?: string | undefined;
    }
  | {
      kind: "state_override";
      state: AsyncScoringState;
    }
  | {
      kind: "state_force_reselect";
    }
  | {
      kind: "state_enabled_force_rescore";
    }
  | {
      kind: "trigger_functions";
      triggered_functions: Array<{
        function_id?: unknown | undefined;
        scope:
          | {
              type: "span";
            }
          | {
              type: "trace";
            };
        idempotency_key?: string | undefined;
      }>;
    }
  | {
      kind: "complete_triggered_functions";
      function_ids: Array<unknown>;
      triggered_xact_id: string;
    }
  | {
      kind: "mark_attempt_failed";
      function_ids: Array<unknown>;
    };
export interface BraintrustAttachmentReference {
  type: "braintrust_attachment";
  filename: string;
  content_type: string;
  key: string;
}
export interface ExternalAttachmentReference {
  type: "external_attachment";
  filename: string;
  content_type: string;
  url: string;
}
export type AttachmentReference =
  | BraintrustAttachmentReference
  | ExternalAttachmentReference;
export type UploadStatus = "uploading" | "done" | "error";
export interface AttachmentStatus {
  upload_status: UploadStatus;
  error_message?: string | undefined;
}
export type FunctionTypeEnum =
  | "llm"
  | "scorer"
  | "task"
  | "tool"
  | "custom_view"
  | "preprocessor"
  | "facet"
  | "classifier"
  | "tag"
  | "parameters"
  | "sandbox";
export type SavedFunctionId =
  | {
      type: "function";
      id: string;
      version?: string | undefined;
    }
  | {
      type: "global";
      name: string;
      function_type: FunctionTypeEnum;
    };
export type CallEvent =
  | {
      id?: string | undefined;
      data: string;
      event: "text_delta";
    }
  | {
      id?: string | undefined;
      data: string;
      event: "reasoning_delta";
    }
  | {
      id?: string | undefined;
      data: string;
      event: "json_delta";
    }
  | {
      id?: string | undefined;
      data: string;
      event: "progress";
    }
  | {
      id?: string | undefined;
      data: string;
      event: "error";
    }
  | {
      id?: string | undefined;
      data: string;
      event: "console";
    }
  | {
      id?: string | undefined;
      event: "start";
      data: "";
    }
  | {
      id?: string | undefined;
      event: "done";
      data: "";
    };
interface CacheControl {
  type: "ephemeral";
  ttl?: "5m" | "1h" | undefined;
}

export interface ChatCompletionContentPartImageWithTitle {
  image_url: {
    url: string;
    detail?: ("auto" | "low" | "high") | undefined;
  };
  type: "image_url";
  cache_control?: CacheControl | undefined;
}
export interface ChatCompletionContentPartFileFile {
  file_data?: string;
  filename?: string;
  file_id?: string;
}
export interface ChatCompletionContentPartFileWithTitle {
  file: ChatCompletionContentPartFileFile;
  type: "file";
  cache_control?: CacheControl | undefined;
}
export type ChatCompletionContentPart =
  | ChatCompletionContentPartText
  | ChatCompletionContentPartImageWithTitle
  | ChatCompletionContentPartFileWithTitle;
export interface ChatCompletionContentPartText {
  text: string;
  type: "text";
  cache_control?: CacheControl | undefined;
}
export interface ChatCompletionMessageToolCall {
  id: string;
  function: {
    arguments: string;
    name: string;
  };
  type: "function";
}
export interface ChatCompletionMessageReasoning {
  id?: string;
  content?: string;
}
export type ChatCompletionMessageParam =
  | ChatCompletionOpenAIMessageParam
  | {
      role: "model";
      content?: string | null | undefined;
    };
export type ChatCompletionOpenAIMessageParam =
  | {
      content: string | Array<ChatCompletionContentPartText>;
      role: "system";
      name?: string | undefined;
    }
  | {
      content: string | Array<ChatCompletionContentPart>;
      role: "user";
      name?: string | undefined;
    }
  | {
      role: "assistant";
      content?:
        | (string | Array<ChatCompletionContentPartText> | null)
        | undefined;
      function_call?:
        | {
            arguments: string;
            name: string;
          }
        | undefined;
      name?: string | undefined;
      tool_calls?: Array<ChatCompletionMessageToolCall> | undefined;
      reasoning?: Array<ChatCompletionMessageReasoning> | undefined;
      reasoning_signature?: string | undefined;
    }
  | {
      content: string | Array<ChatCompletionContentPartText>;
      role: "tool";
      tool_call_id: string;
    }
  | {
      content: string | null;
      name: string;
      role: "function";
    }
  | {
      content: string | Array<ChatCompletionContentPartText>;
      role: "developer";
      name?: string | undefined;
    };
export interface ChatCompletionTool {
  function: {
    name: string;
    description?: string | undefined;
    parameters?: {} | undefined;
  };
  type: "function";
}
export interface DatasetSnapshot {
  id: string;
  dataset_id: string;
  name: string;
  description: string | null;
  xact_id: string;
  created: string | null;
}
export type RepoInfo = {
  commit?: string | null;
  branch?: string | null;
  tag?: string | null;
  dirty?: boolean | null;
  author_name?: string | null;
  author_email?: string | null;
  commit_message?: string | null;
  commit_time?: string | null;
  git_diff?: string | null;
} | null;
export type ExtendedSavedFunctionId =
  | SavedFunctionId
  | {
      type: "slug";
      project_id: string;
      slug: string;
    };
// Keep provider fields visible to editor completion while accepting custom options.
export type ModelParams =
  | {
      use_cache?: boolean;
      reasoning_enabled?: boolean;
      reasoning_budget?: number;
      temperature?: number;
      top_p?: number;
      max_tokens?: number;
      max_completion_tokens?: number;
      frequency_penalty?: number;
      presence_penalty?: number;
      response_format?: ResponseFormatNullish;
      tool_choice?:
        | "auto"
        | "none"
        | "required"
        | {
            type: "function";
            function: {
              name: string;
            };
          };
      function_call?:
        | "auto"
        | "none"
        | {
            name: string;
          };
      n?: number;
      stop?: Array<string>;
      reasoning_effort?: "none" | "minimal" | "low" | "medium" | "high";
      verbosity?: "low" | "medium" | "high";
      [key: string]: any;
    }
  | {
      use_cache?: boolean | undefined;
      reasoning_enabled?: boolean | undefined;
      reasoning_budget?: number | undefined;
      max_tokens: number;
      temperature: number;
      top_p?: number | undefined;
      top_k?: number | undefined;
      stop_sequences?: Array<string> | undefined;
      max_tokens_to_sample?: number | undefined;
      [key: string]: any;
    }
  | {
      use_cache?: boolean;
      reasoning_enabled?: boolean;
      reasoning_budget?: number;
      temperature?: number;
      maxOutputTokens?: number;
      topP?: number;
      topK?: number;
      [key: string]: any;
    }
  | {
      use_cache?: boolean;
      reasoning_enabled?: boolean;
      reasoning_budget?: number;
      temperature?: number;
      topK?: number;
      [key: string]: any;
    }
  | {
      use_cache?: boolean;
      reasoning_enabled?: boolean;
      reasoning_budget?: number;
      [key: string]: any;
    };
export type PromptOptionsNullish = {
  model?: string;
  params?: ModelParams;
  position?: string;
  endpoint_name?: string | null;
} | null;
export type PromptParserNullish = {
  type: "llm_classifier";
  use_cot: boolean;
  choice_scores?: {} | undefined;
  choice?: Array<string> | undefined;
  allow_no_match?: boolean | undefined;
  allow_skip?: boolean | undefined;
} | null;
export type PreprocessorId =
  | {
      type: "function";
      id: string;
      version?: string | undefined;
    }
  | {
      type: "global";
      name: string;
      function_type: "preprocessor";
    }
  | {
      type: "inline";
      code: string;
    }
  | null;
export type PromptBlockData =
  | {
      type: "chat";
      messages: Array<ChatCompletionMessageParam>;
      tools?: string | undefined;
    }
  | {
      type: "completion";
      content: string;
    };
export type FunctionFormat = "llm" | "code" | "global" | "graph" | "topic_map";
export interface PromptData {
  prompt?: PromptBlockData | null;
  options?: PromptOptionsNullish;
  parser?: PromptParserNullish;
  preprocessor?: PreprocessorId;
  tool_functions?: Array<SavedFunctionId> | null;
  template_format?: ("mustache" | "nunjucks" | "none") | null;
  mcp?: {} | null;
  origin?: {
    prompt_id?: string;
    project_id?: string;
    prompt_version?: string;
  } | null;
}
export type FunctionId =
  | {
      function_id: string;
      version?: string | undefined;
    }
  | {
      project_name: string;
      slug: string;
      version?: string | undefined;
    }
  | {
      global_function: string;
      function_type: FunctionTypeEnum;
    }
  | {
      prompt_session_id: string;
      prompt_session_function_id: string;
      version?: string | undefined;
    }
  | {
      inline_context: {
        runtime: "node" | "python" | "browser" | "quickjs";
        version: string;
      };
      code: string;
      function_type?: FunctionTypeEnum | undefined;
      name?: (string | null) | undefined;
    }
  | {
      inline_prompt?: PromptData | undefined;
      inline_function: {};
      function_type: FunctionTypeEnum;
      name?: (string | null) | undefined;
    }
  | {
      inline_prompt: PromptData;
      function_type: FunctionTypeEnum;
      name?: (string | null) | undefined;
    };
export type FunctionObjectType =
  | "prompt"
  | "tool"
  | "scorer"
  | "task"
  | "workflow"
  | "custom_view"
  | "preprocessor"
  | "facet"
  | "classifier"
  | "parameters"
  | "sandbox";
export type FunctionOutputType =
  | "completion"
  | "score"
  | "facet"
  | "classification"
  | "any";
export interface GitMetadataSettings {
  collect: "all" | "none" | "some";
  fields?:
    | Array<
        | "commit"
        | "branch"
        | "tag"
        | "dirty"
        | "author_name"
        | "author_email"
        | "commit_message"
        | "commit_time"
        | "git_diff"
      >
    | undefined;
}
export type IfExists = "error" | "ignore" | "replace";
export type InvokeParent =
  | {
      object_type: "project_logs" | "experiment" | "playground_logs";
      object_id: string;
      row_ids?:
        | ({
            id: string;
            span_id: string;
            root_span_id: string;
          } | null)
        | undefined;
      propagated_event?: ({} | null) | undefined;
    }
  | string;
export type StreamingMode = ("auto" | "parallel" | "json" | "text") | null;
export type InvokeFunction = FunctionId & {
  input?: unknown;
  expected?: unknown;
  metadata?: {} | null;
  tags?: Array<string> | null;
  messages?: Array<ChatCompletionMessageParam>;
  parent?: InvokeParent;
  stream?: boolean | null;
  mode?: StreamingMode;
  strict?: boolean | null;
  mcp_auth?: {};
  overrides?: {} | null;
  endpoint_name?: string | null;
};
export interface ObjectReference {
  object_type:
    | "project_logs"
    | "experiment"
    | "dataset"
    | "prompt"
    | "function"
    | "prompt_session";
  object_id: string;
  id: string;
  _xact_id?: (string | null) | undefined;
  created?: (string | null) | undefined;
}
export interface PromptSessionEvent {
  id: string;
  _xact_id: string;
  created: string;
  _pagination_key?: (string | null) | undefined;
  project_id: string;
  prompt_session_id: string;
  prompt_session_data?: unknown | undefined;
  prompt_data?: unknown | undefined;
  function_data?: unknown | undefined;
  function_type?: FunctionTypeEnum | null | undefined;
  object_data?: unknown | undefined;
  completion?: unknown | undefined;
  tags?: (Array<string> | null) | undefined;
}
export interface SSEConsoleEventData {
  stream: "stderr" | "stdout";
  message: string;
}
export interface SSEProgressEventData {
  id: string;
  object_type: FunctionObjectType;
  origin?: (ObjectReference | null) | undefined;
  format: FunctionFormat;
  output_type: FunctionOutputType;
  name: string;
  event:
    | "reasoning_delta"
    | "text_delta"
    | "json_delta"
    | "error"
    | "console"
    | "start"
    | "done"
    | "progress";
  data: string;
}
export interface ToolFunctionDefinition {
  type: "function";
  function: {
    name: string;
    description?: string | undefined;
    parameters?: {} | undefined;
    strict?: (boolean | null) | undefined;
  };
}
