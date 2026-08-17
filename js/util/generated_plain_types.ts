// Auto-generated file (content hash e392acbca346c32a) -- do not modify

export type AclObjectTypeType =
  /**
   * The object type that the ACL applies to
   *
   * @enum organization, project, experiment, dataset, prompt, prompt_session, group, role, org_member, project_log, org_project, org_audit_logs, project_group
   */
  | /**
   * The object type that the ACL applies to
   *
   * @enum organization, project, experiment, dataset, prompt, prompt_session, group, role, org_member, project_log, org_project, org_audit_logs, project_group
   */
  (| "organization"
      | "project"
      | "experiment"
      | "dataset"
      | "prompt"
      | "prompt_session"
      | "group"
      | "role"
      | "org_member"
      | "project_log"
      | "org_project"
      | "org_audit_logs"
      | "project_group"
    )
  /**
   * The object type that the ACL applies to
   *
   * @enum organization, project, experiment, dataset, prompt, prompt_session, group, role, org_member, project_log, org_project, org_audit_logs, project_group
   */
  | null;
export type PermissionType =
  /**
 * Each permission permits a certain type of operation on an object in the system

Permissions can be assigned to to objects on an individual basis, or grouped into roles
 *
 * @enum create, read, update, delete, create_acls, read_acls, update_acls, delete_acls
 */
  | "create"
  | "read"
  | "update"
  | "delete"
  | "create_acls"
  | "read_acls"
  | "update_acls"
  | "delete_acls";
export type AclType = {
  /**
   * Unique identifier for the acl
   */
  id: string;
  object_type: AclObjectTypeType & string;
  /**
   * The id of the object the ACL applies to
   */
  object_id: string;
  user_id?:
    | /**
     * Id of the user the ACL applies to. Exactly one of `user_id` and `group_id` will be provided
     */
    /**
     * Id of the user the ACL applies to. Exactly one of `user_id` and `group_id` will be provided
     */
    (| string
        /**
         * Id of the user the ACL applies to. Exactly one of `user_id` and `group_id` will be provided
         */
        | null
      )
    | undefined;
  group_id?:
    | /**
     * Id of the group the ACL applies to. Exactly one of `user_id` and `group_id` will be provided
     */
    /**
     * Id of the group the ACL applies to. Exactly one of `user_id` and `group_id` will be provided
     */
    (| string
        /**
         * Id of the group the ACL applies to. Exactly one of `user_id` and `group_id` will be provided
         */
        | null
      )
    | undefined;
  permission?:
    | (PermissionType &
        /**
         * Permission the ACL grants. Exactly one of `permission` and `role_id` will be provided
         */ /**
         * Permission the ACL grants. Exactly one of `permission` and `role_id` will be provided
         */
        (| string
          /**
           * Permission the ACL grants. Exactly one of `permission` and `role_id` will be provided
           */
          | null
        ))
    | undefined;
  restrict_object_type?:
    | (AclObjectTypeType &
        /**
         * When setting a permission directly, optionally restricts the permission grant to just the specified object type. Cannot be set alongside a `role_id`.
         */ unknown)
    | undefined;
  role_id?:
    | /**
     * Id of the role the ACL grants. Exactly one of `permission` and `role_id` will be provided
     */
    /**
     * Id of the role the ACL grants. Exactly one of `permission` and `role_id` will be provided
     */
    (| string
        /**
         * Id of the role the ACL grants. Exactly one of `permission` and `role_id` will be provided
         */
        | null
      )
    | undefined;
  /**
   * The organization the ACL's referred object belongs to
   */
  _object_org_id: string;
  created?:
    | /**
     * Date of acl creation
     */
    /**
     * Date of acl creation
     */
    (| string
        /**
         * Date of acl creation
         */
        | null
      )
    | undefined;
};
export type AgentType = {
  /**
   * Unique identifier for the agent
   */
  id: string;
  /**
   * Unique identifier for the project that the agent belongs under
   */
  project_id: string;
  user_id: string;
  created?:
    | /**
     * Date of agent creation
     */
    /**
     * Date of agent creation
     */
    (| string
        /**
         * Date of agent creation
         */
        | null
      )
    | undefined;
  /**
   * Name of the agent. Within a project, agent names are unique
   */
  name: string;
  /**
   * Stable, URL-safe identifier for the agent, unique within its project.
   */
  slug: string;
  /**
   * Agent classification: 'custom' for customer-defined agents, 'loop' for built-in Loop agents.
   */
  kind: string;
  description?:
    | /**
     * Textual description of the agent
     */
    /**
     * Textual description of the agent
     */
    (| string
        /**
         * Textual description of the agent
         */
        | null
      )
    | undefined;
  metadata?:
    | /**
     * User-controlled metadata about the agent
     */
    /**
     * User-controlled metadata about the agent
     */
    (| {}
        /**
         * User-controlled metadata about the agent
         */
        | null
      )
    | undefined;
};
export type AISecretType = {
  /**
   * Unique identifier for the AI secret
   */
  id: string;
  created?:
    | /**
     * Date of AI secret creation
     */
    /**
     * Date of AI secret creation
     */
    (| string
        /**
         * Date of AI secret creation
         */
        | null
      )
    | undefined;
  updated_at?:
    | /**
     * Date of last AI secret update
     */
    /**
     * Date of last AI secret update
     */
    (| string
        /**
         * Date of last AI secret update
         */
        | null
      )
    | undefined;
  secret_updated_at?:
    | /**
     * Date of last update to the encrypted secret value itself
     */
    /**
     * Date of last update to the encrypted secret value itself
     */
    (| string
        /**
         * Date of last update to the encrypted secret value itself
         */
        | null
      )
    | undefined;
  /**
   * Unique identifier for the organization
   */
  org_id: string;
  /**
   * Name of the AI secret
   */
  name: string;
  type?: (string | null) | undefined;
  metadata?: ({} | null) | undefined;
  secret_updated_by_user_id?:
    | /**
     * User id of the last update to the encrypted secret value
     */
    /**
     * User id of the last update to the encrypted secret value
     */
    (| string
        /**
         * User id of the last update to the encrypted secret value
         */
        | null
      )
    | undefined;
  preview_secret?: (string | null) | undefined;
};
export type ResponseFormatJsonSchemaType = {
  name: string;
  description?: string | undefined;
  schema?: ({} | string) | undefined;
  strict?: (boolean | null) | undefined;
};
export type ResponseFormatNullishType =
  | {
      /**
       * @enum json_object
       */
      type: "json_object";
    }
  | {
      /**
       * @enum json_schema
       */
      type: "json_schema";
      json_schema: ResponseFormatJsonSchemaType;
    }
  | {
      /**
       * @enum text
       */
      type: "text";
    }
  | null;
export type AnyModelParamsType = {
  temperature?: number | undefined;
  top_p?: number | undefined;
  max_tokens: number;
  max_completion_tokens?: /**
     * The successor to max_tokens
     */
    number | undefined;
  frequency_penalty?: number | undefined;
  presence_penalty?: number | undefined;
  response_format?: ResponseFormatNullishType | undefined;
  tool_choice?:
    | (
        | /**
         * @enum auto
         */
        "auto"
        /**
         * @enum none
         */
        | "none"
        /**
         * @enum required
         */
        | "required"
        | {
            /**
             * @enum function
             */
            type: "function";
            function: {
              name: string;
            };
          }
      )
    | undefined;
  function_call?:
    | (
        | /**
         * @enum auto
         */
        "auto"
        /**
         * @enum none
         */
        | "none"
        | {
            name: string;
          }
      )
    | undefined;
  n?: number | undefined;
  stop?: Array<string> | undefined;
  reasoning_effort?:
    | /**
     * @enum none, minimal, low, medium, high
     */
    ("none" | "minimal" | "low" | "medium" | "high")
    | undefined;
  verbosity?:
    | /**
     * @enum low, medium, high
     */
    ("low" | "medium" | "high")
    | undefined;
  top_k?: number | undefined;
  stop_sequences?: Array<string> | undefined;
  reasoning_enabled?: boolean | undefined;
  reasoning_budget?: number | undefined;
  max_tokens_to_sample?: /**
     * This is a legacy parameter that should not be used.
     */
    number | undefined;
  maxOutputTokens?: number | undefined;
  topP?: number | undefined;
  topK?: number | undefined;
  use_cache?: boolean | undefined;
};
export type ApiKeyType = {
  /**
   * Unique identifier for the api key
   */
  id: string;
  created?:
    | /**
     * Date of api key creation
     */
    /**
     * Date of api key creation
     */
    (| string
        /**
         * Date of api key creation
         */
        | null
      )
    | undefined;
  /**
   * Name of the api key
   */
  name: string;
  preview_name: string;
  user_id?:
    | /**
     * Unique identifier for the user
     */
    /**
     * Unique identifier for the user
     */
    (| string
        /**
         * Unique identifier for the user
         */
        | null
      )
    | undefined;
  user_email?:
    | /**
     * The user's email
     */
    /**
     * The user's email
     */
    (| string
        /**
         * The user's email
         */
        | null
      )
    | undefined;
  user_given_name?:
    | /**
     * Given name of the user
     */
    /**
     * Given name of the user
     */
    (| string
        /**
         * Given name of the user
         */
        | null
      )
    | undefined;
  user_family_name?:
    | /**
     * Family name of the user
     */
    /**
     * Family name of the user
     */
    (| string
        /**
         * Family name of the user
         */
        | null
      )
    | undefined;
  org_id?:
    | /**
     * Unique identifier for the organization
     */
    /**
     * Unique identifier for the organization
     */
    (| string
        /**
         * Unique identifier for the organization
         */
        | null
      )
    | undefined;
  expires_at?:
    | /**
     * Date at which the API key expires. If null, the key never expires.
     */
    /**
     * Date at which the API key expires. If null, the key never expires.
     */
    (| string
        /**
         * Date at which the API key expires. If null, the key never expires.
         */
        | null
      )
    | undefined;
};
export type TriggeredFunctionStateType = {
  /**
   * The xact_id when this function was triggered
   */
  triggered_xact_id: string;
  completed_xact_id?:
    | /**
     * The xact_id when this function completed (matches triggered_xact_id if done)
     */
    /**
     * The xact_id when this function completed (matches triggered_xact_id if done)
     */
    (| string
        /**
         * The xact_id when this function completed (matches triggered_xact_id if done)
         */
        | null
      )
    | undefined;
  idempotency_key?:
    | /**
     * Deterministic key of the function definition + input version used to skip unchanged reruns
     */
    /**
     * Deterministic key of the function definition + input version used to skip unchanged reruns
     */
    (| string
        /**
         * Deterministic key of the function definition + input version used to skip unchanged reruns
         */
        | null
      )
    | undefined;
  /**
   * Number of execution attempts (for retry tracking)
   *
   * @default 0
   * @minimum 0
   */
  attempts: number;
  /**
   * The scope of data this function operates on
   */
  scope:
    | {
        /**
         * @enum span
         */
        type: "span";
      }
    | {
        /**
         * @enum trace
         */
        type: "trace";
      }
    | {
        /**
         * @enum group
         */
        type: "group";
        key: string;
        value: string;
      };
};
export type AsyncScoringStateType =
  | {
      /**
       * @enum enabled
       */
      status: "enabled";
      token: string;
      function_ids: Array<unknown>;
      skip_logging?: (boolean | null) | undefined;
      triggered_functions?: ({} | null) | undefined;
      last_triggered_xact_id?:
        | /**
         * The xact_id of the last non-score change to this row (excludes scorer score merges)
         */
        (string | number | null)
        | undefined;
    }
  | {
      /**
       * @enum disabled
       */
      status: "disabled";
    }
  | null
  | null;
export type AsyncScoringControlType =
  | {
      /**
       * @enum score_update
       */
      kind: "score_update";
      token?: string | undefined;
    }
  | {
      /**
       * @enum state_override
       */
      kind: "state_override";
      state: AsyncScoringStateType;
    }
  | {
      /**
       * @enum state_force_reselect
       */
      kind: "state_force_reselect";
    }
  | {
      /**
       * @enum state_enabled_force_rescore
       */
      kind: "state_enabled_force_rescore";
    }
  | {
      /**
       * @enum trigger_functions
       */
      kind: "trigger_functions";
      triggered_functions: Array<{
        function_id?: unknown | undefined;
        scope:
          | {
              /**
               * @enum span
               */
              type: "span";
            }
          | {
              /**
               * @enum trace
               */
              type: "trace";
            };
        idempotency_key?: string | undefined;
      }>;
    }
  | {
      /**
       * @enum complete_triggered_functions
       */
      kind: "complete_triggered_functions";
      function_ids: Array<unknown>;
      triggered_xact_id: string;
    }
  | {
      /**
       * @enum mark_attempt_failed
       */
      kind: "mark_attempt_failed";
      function_ids: Array<unknown>;
    };
export type BraintrustAttachmentReferenceType = {
  /**
   * An identifier to help disambiguate parsing.
   *
   * @enum braintrust_attachment
   */
  type: "braintrust_attachment";
  /**
   * Human-readable filename for user interfaces. Not related to attachment storage.
   *
   * @minLength 1
   */
  filename: string;
  /**
   * MIME type of this file.
   *
   * @minLength 1
   */
  content_type: string;
  /**
   * Key in the object store bucket for this attachment.
   *
   * @minLength 1
   */
  key: string;
};
export type ExternalAttachmentReferenceType = {
  /**
   * An identifier to help disambiguate parsing.
   *
   * @enum external_attachment
   */
  type: "external_attachment";
  /**
   * Human-readable filename for user interfaces. Not related to attachment storage.
   *
   * @minLength 1
   */
  filename: string;
  /**
   * MIME type of this file.
   *
   * @minLength 1
   */
  content_type: string;
  /**
   * Fully qualified URL to the object in the external object store.
   *
   * @minLength 1
   */
  url: string;
};
export type AttachmentReferenceType =
  | BraintrustAttachmentReferenceType
  | ExternalAttachmentReferenceType;
export type UploadStatusType =
  /**
   * @enum uploading, done, error
   */
  "uploading" | "done" | "error";
export type AttachmentStatusType = {
  upload_status: UploadStatusType;
  error_message?: /**
     * Describes the error encountered while uploading.
     */
    string | undefined;
};
export type AutomationStatusType =
  /**
   * Whether the automation is active or paused.
   *
   * @enum active, paused
   */
  "active" | "paused";
export type FunctionTypeEnumType =
  /**
   * The type of global function. Defaults to 'scorer'.
   *
   * @default "scorer"
   * @enum llm, scorer, task, tool, custom_view, preprocessor, facet, classifier, tag, parameters, sandbox
   */
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
export type FacetPreprocessorIdType =
  /**
   * The saved, global, or inline preprocessor to use for facet extraction. If not provided, the project default preprocessor will be used, falling back to the global 'thread' preprocessor.
   */
  | {
      /**
       * @enum function
       */
      type: "function";
      id: string;
      version?: /**
         * The version of the function
         */
        string | undefined;
    }
  | {
      /**
       * @enum global
       */
      type: "global";
      name: string;
      function_type: FunctionTypeEnumType;
    }
  | {
      /**
       * @enum inline
       */
      type: "inline";
      /**
       * The complete JavaScript preprocessor implementation, including its handler.
       *
       * @minLength 1
       */
      code: string;
    }
  | null;
export type SavedFunctionIdType =
  | {
      /**
       * @enum function
       */
      type: "function";
      id: string;
      version?: /**
         * The version of the function
         */
        string | undefined;
    }
  | {
      /**
       * @enum global
       */
      type: "global";
      name: string;
      function_type: FunctionTypeEnumType;
    };
export type TopicMapGenerationSettingsType = {
  /**
   * @enum hdbscan, kmeans, community
   */
  algorithm: "hdbscan" | "kmeans" | "community";
  /**
   * @enum umap, pca, none
   */
  dimension_reduction: "umap" | "pca" | "none";
  sample_size?: number | undefined;
  n_clusters?: number | undefined;
  min_cluster_size?: number | undefined;
  min_samples?: number | undefined;
  hierarchy_threshold?: number | undefined;
  naming_model?: string | undefined;
};
export type TopicMapDataType = {
  /**
   * @enum topic_map
   */
  type: "topic_map";
  /**
   * Materialized facet field name used when source_facet_function is absent
   */
  source_facet: string;
  source_facet_function?:
    | (SavedFunctionIdType &
        /**
         * The stable function reference for the source facet
         */ unknown)
    | undefined;
  /**
   * The embedding model to use for embedding facet values
   */
  embedding_model: string;
  bundle_key?: /**
     * Key of the topic map bundle in code_bundles bucket
     */
    string | undefined;
  report_key?: /**
     * Key of the clustering report in code_bundles bucket
     */
    string | undefined;
  topic_names?: /**
     * Mapping from topic_id to topic name
     */
    {} | undefined;
  generation_settings?: TopicMapGenerationSettingsType | undefined;
  disable_reconciliation?: /**
     * Whether new topic generation should ignore the previously saved report during reconciliation. Defaults to false when omitted.
     */
    boolean | undefined;
  reconcile_mode?:
    | /**
     * How reconciliation carries the previous map forward: "evolve" re-routes new samples into the previous topics before naming; "names_only" keeps the fresh clustering and carries only topic ids/names. Defaults to "names_only" when omitted.
     *
     * @enum evolve, names_only
     */
    ("evolve" | "names_only")
    | undefined;
  distance_threshold?: /**
     * Maximum distance to nearest centroid. If exceeded, returns no_match.
     */
    number | undefined;
  btql_filter?: /**
     * Per-topic-map BTQL filter that was applied when this version was generated. Absent on versions generated before this was recorded.
     */
    string | undefined;
  automation_btql_filter?: /**
     * Automation-level BTQL filter that was applied when this version was generated. Absent on versions generated before this was recorded.
     */
    string | undefined;
};
export type BatchedFacetDataType = {
  /**
   * @enum batched_facet
   */
  type: "batched_facet";
  preprocessor?: FacetPreprocessorIdType | undefined;
  facets: Array<{
    /**
     * The name of the facet
     */
    name: string;
    /**
     * The prompt to use for LLM extraction. The preprocessed text will be provided as context.
     */
    prompt: string;
    model?: /**
       * The model to use for facet extraction
       */
      string | undefined;
    embedding_model?: /**
       * The embedding model to use for vectorizing facet results.
       */
      string | undefined;
    no_match_pattern?: /**
       * Regex pattern to identify outputs that do not match the facet. If the output matches, the facet will be saved as 'no_match'
       */
      string | undefined;
  }>;
  topic_maps?: /**
     * Topic maps that depend on facets in this batch, keyed by source facet name. Each source facet can have multiple topic maps.
     */
    {} | undefined;
};
export type BraintrustModelParamsType = Partial<{
  use_cache: boolean;
  reasoning_enabled: boolean;
  reasoning_budget: number;
}>;
export type CallEventType =
  | {
      id?: string | undefined;
      data: string;
      /**
       * @enum text_delta
       */
      event: "text_delta";
    }
  | {
      id?: string | undefined;
      data: string;
      /**
       * @enum reasoning_delta
       */
      event: "reasoning_delta";
    }
  | {
      id?: string | undefined;
      data: string;
      /**
       * @enum json_delta
       */
      event: "json_delta";
    }
  | {
      id?: string | undefined;
      data: string;
      /**
       * @enum progress
       */
      event: "progress";
    }
  | {
      id?: string | undefined;
      data: string;
      /**
       * @enum error
       */
      event: "error";
    }
  | {
      id?: string | undefined;
      data: string;
      /**
       * @enum console
       */
      event: "console";
    }
  | {
      id?: string | undefined;
      /**
       * @enum start
       */
      event: "start";
      /**
       * @enum
       */
      data: "";
    }
  | {
      id?: string | undefined;
      /**
       * @enum done
       */
      event: "done";
      /**
       * @enum
       */
      data: "";
    };
export type ChatCompletionContentPartTextWithTitleType = {
  /**
   * @default ""
   */
  text: string;
  /**
   * @enum text
   */
  type: "text";
  cache_control?:
    | {
        /**
         * @enum ephemeral
         */
        type: "ephemeral";
        ttl?:
          | /**
           * @enum 5m, 1h
           */
          ("5m" | "1h")
          | undefined;
      }
    | undefined;
};
export type ChatCompletionContentPartImageWithTitleType = {
  image_url: {
    url: string;
    detail?:
      | (
          | /**
           * @enum auto
           */
          "auto"
          /**
           * @enum low
           */
          | "low"
          /**
           * @enum high
           */
          | "high"
        )
      | undefined;
  };
  /**
   * @enum image_url
   */
  type: "image_url";
  cache_control?:
    | {
        /**
         * @enum ephemeral
         */
        type: "ephemeral";
        ttl?:
          | /**
           * @enum 5m, 1h
           */
          ("5m" | "1h")
          | undefined;
      }
    | undefined;
};
export type ChatCompletionContentPartFileFileType = Partial<{
  file_data: string;
  filename: string;
  file_id: string;
}>;
export type ChatCompletionContentPartFileWithTitleType = {
  file: ChatCompletionContentPartFileFileType;
  /**
   * @enum file
   */
  type: "file";
  cache_control?:
    | {
        /**
         * @enum ephemeral
         */
        type: "ephemeral";
        ttl?:
          | /**
           * @enum 5m, 1h
           */
          ("5m" | "1h")
          | undefined;
      }
    | undefined;
};
export type ChatCompletionContentPartType =
  | ChatCompletionContentPartTextWithTitleType
  | ChatCompletionContentPartImageWithTitleType
  | ChatCompletionContentPartFileWithTitleType;
export type ChatCompletionContentPartTextType = {
  /**
   * @default ""
   */
  text: string;
  /**
   * @enum text
   */
  type: "text";
  cache_control?:
    | {
        /**
         * @enum ephemeral
         */
        type: "ephemeral";
        ttl?:
          | /**
           * @enum 5m, 1h
           */
          ("5m" | "1h")
          | undefined;
      }
    | undefined;
};
export type ChatCompletionMessageToolCallType = {
  id: string;
  function: {
    arguments: string;
    name: string;
  };
  /**
   * @enum function
   */
  type: "function";
};
export type ChatCompletionMessageReasoningType = Partial<{
  id: string;
  content: string;
}>;
export type ChatCompletionMessageParamType =
  | {
      content: /**
         * @default ""
         */
        string | Array<ChatCompletionContentPartTextType>;
      /**
       * @enum system
       */
      role: "system";
      name?: string | undefined;
    }
  | {
      content: /**
         * @default ""
         */
        string | Array<ChatCompletionContentPartType>;
      /**
       * @enum user
       */
      role: "user";
      name?: string | undefined;
    }
  | {
      /**
       * @enum assistant
       */
      role: "assistant";
      content?:
        | (string | Array<ChatCompletionContentPartTextType> | null)
        | undefined;
      function_call?:
        | {
            arguments: string;
            name: string;
          }
        | undefined;
      name?: string | undefined;
      tool_calls?: Array<ChatCompletionMessageToolCallType> | undefined;
      reasoning?: Array<ChatCompletionMessageReasoningType> | undefined;
      reasoning_signature?: string | undefined;
    }
  | {
      content: /**
         * @default ""
         */
        string | Array<ChatCompletionContentPartTextType>;
      /**
       * @enum tool
       */
      role: "tool";
      /**
       * @default ""
       */
      tool_call_id: string;
    }
  | {
      content: string | null;
      name: string;
      /**
       * @enum function
       */
      role: "function";
    }
  | {
      content: /**
         * @default ""
         */
        string | Array<ChatCompletionContentPartTextType>;
      /**
       * @enum developer
       */
      role: "developer";
      name?: string | undefined;
    }
  | {
      /**
       * @enum model
       */
      role: "model";
      content?: (string | null) | undefined;
    };
export type ChatCompletionOpenAIMessageParamType =
  | {
      content: /**
         * @default ""
         */
        string | Array<ChatCompletionContentPartTextType>;
      /**
       * @enum system
       */
      role: "system";
      name?: string | undefined;
    }
  | {
      content: /**
         * @default ""
         */
        string | Array<ChatCompletionContentPartType>;
      /**
       * @enum user
       */
      role: "user";
      name?: string | undefined;
    }
  | {
      /**
       * @enum assistant
       */
      role: "assistant";
      content?:
        | (string | Array<ChatCompletionContentPartTextType> | null)
        | undefined;
      function_call?:
        | {
            arguments: string;
            name: string;
          }
        | undefined;
      name?: string | undefined;
      tool_calls?: Array<ChatCompletionMessageToolCallType> | undefined;
      reasoning?: Array<ChatCompletionMessageReasoningType> | undefined;
      reasoning_signature?: string | undefined;
    }
  | {
      content: /**
         * @default ""
         */
        string | Array<ChatCompletionContentPartTextType>;
      /**
       * @enum tool
       */
      role: "tool";
      /**
       * @default ""
       */
      tool_call_id: string;
    }
  | {
      content: string | null;
      name: string;
      /**
       * @enum function
       */
      role: "function";
    }
  | {
      content: /**
         * @default ""
         */
        string | Array<ChatCompletionContentPartTextType>;
      /**
       * @enum developer
       */
      role: "developer";
      name?: string | undefined;
    };
export type ChatCompletionToolType = {
  function: {
    name: string;
    description?: string | undefined;
    parameters?: {} | undefined;
  };
  /**
   * @enum function
   */
  type: "function";
};
export type CodeBundleType = {
  runtime_context: {
    /**
     * @enum node, python, browser, quickjs
     */
    runtime: "node" | "python" | "browser" | "quickjs";
    version: string;
  };
  location:
    | {
        /**
         * @enum experiment
         */
        type: "experiment";
        eval_name: string;
        position:
          | {
              /**
               * @enum task
               */
              type: "task";
            }
          | {
              /**
               * @enum scorer
               */
              type: "scorer";
              /**
               * @minimum 0
               */
              index: number;
            }
          | {
              /**
               * @enum classifier
               */
              type: "classifier";
              /**
               * @minimum 0
               */
              index: number;
            };
      }
    | {
        /**
         * @enum function
         */
        type: "function";
        /**
         * @minimum 0
         */
        index: number;
      }
    | {
        /**
         * @enum sandbox
         */
        type: "sandbox";
        sandbox_spec:
          | {
              /**
               * @enum modal
               */
              provider: "modal";
              /**
               * sandbox snapshot ref
               */
              snapshot_ref: string;
            }
          | {
              /**
               * @enum lambda
               */
              provider: "lambda";
            };
        entrypoints?: /**
           * Which entrypoints to execute in the sandbox
           */
          Array<string> | undefined;
        eval_name: string;
        parameters?: /**
           * Parameter values for sandbox eval execution
           */
          {} | undefined;
        evaluator_definition?: /**
           * Definition of current evaluator with parameters
           */
          unknown | undefined;
      };
  bundle_id?: (string | null) | undefined;
  preview?:
    | /**
     * A preview of the code
     */
    /**
     * A preview of the code
     */
    (| string
        /**
         * A preview of the code
         */
        | null
      )
    | undefined;
};
export type DatasetType = {
  /**
   * Unique identifier for the dataset
   */
  id: string;
  /**
   * Unique identifier for the project that the dataset belongs under
   */
  project_id: string;
  /**
   * Name of the dataset. Within a project, dataset names are unique
   */
  name: string;
  description?:
    | /**
     * Textual description of the dataset
     */
    /**
     * Textual description of the dataset
     */
    (| string
        /**
         * Textual description of the dataset
         */
        | null
      )
    | undefined;
  created?:
    | /**
     * Date of dataset creation
     */
    /**
     * Date of dataset creation
     */
    (| string
        /**
         * Date of dataset creation
         */
        | null
      )
    | undefined;
  deleted_at?:
    | /**
     * Date of dataset deletion, or null if the dataset is still active
     */
    /**
     * Date of dataset deletion, or null if the dataset is still active
     */
    (| string
        /**
         * Date of dataset deletion, or null if the dataset is still active
         */
        | null
      )
    | undefined;
  user_id?:
    | /**
     * Identifies the user who created the dataset
     */
    /**
     * Identifies the user who created the dataset
     */
    (| string
        /**
         * Identifies the user who created the dataset
         */
        | null
      )
    | undefined;
  tags?:
    | /**
     * A list of tags for the dataset
     */
    /**
     * A list of tags for the dataset
     */
    (| Array<string>
        /**
         * A list of tags for the dataset
         */
        | null
      )
    | undefined;
  metadata?:
    | /**
     * User-controlled metadata about the dataset
     */
    /**
     * User-controlled metadata about the dataset
     */
    (| {}
        /**
         * User-controlled metadata about the dataset
         */
        | null
      )
    | undefined;
  /**
   * URL slug for the dataset. used to construct dataset URLs
   */
  url_slug: string;
};
export type ObjectReferenceNullishType =
  /**
   * Indicates the event was copied from another object.
   */
  /**
   * Indicates the event was copied from another object.
   */
  | {
      /**
       * Type of the object the event is originating from.
       *
       * @enum project_logs, experiment, dataset, prompt, function, prompt_session
       */
      object_type:
        | "project_logs"
        | "experiment"
        | "dataset"
        | "prompt"
        | "function"
        | "prompt_session";
      /**
       * ID of the object the event is originating from.
       */
      object_id: string;
      /**
       * ID of the original event.
       */
      id: string;
      _xact_id?:
        | /**
         * Transaction ID of the original event.
         */
        /**
         * Transaction ID of the original event.
         */
        (| string
            /**
             * Transaction ID of the original event.
             */
            | null
          )
        | undefined;
      created?:
        | /**
         * Created timestamp of the original event. Used to help sort in the UI
         */
        /**
         * Created timestamp of the original event. Used to help sort in the UI
         */
        (| string
            /**
             * Created timestamp of the original event. Used to help sort in the UI
             */
            | null
          )
        | undefined;
    }
  /**
   * Indicates the event was copied from another object.
   */
  | null;
export type DatasetEventType = {
  /**
   * A unique identifier for the dataset event. If you don't provide one, Braintrust will generate one for you
   */
  id: string;
  /**
   * The transaction id of an event is unique to the network operation that processed the event insertion. Transaction ids are monotonically increasing over time and can be used to retrieve a versioned snapshot of the dataset (see the `version` parameter)
   */
  _xact_id: string;
  /**
   * The timestamp the dataset event was created
   */
  created: string;
  _pagination_key?:
    | /**
     * A stable, time-ordered key that can be used to paginate over dataset events. This field is auto-generated by Braintrust and only exists in Brainstore.
     */
    /**
     * A stable, time-ordered key that can be used to paginate over dataset events. This field is auto-generated by Braintrust and only exists in Brainstore.
     */
    (| string
        /**
         * A stable, time-ordered key that can be used to paginate over dataset events. This field is auto-generated by Braintrust and only exists in Brainstore.
         */
        | null
      )
    | undefined;
  /**
   * Unique identifier for the project that the dataset belongs under
   */
  project_id: string;
  /**
   * Unique identifier for the dataset
   */
  dataset_id: string;
  input?: /**
     * The argument that uniquely define an input case (an arbitrary, JSON serializable object)
     */
    unknown | undefined;
  expected?: /**
     * The output of your application, including post-processing (an arbitrary, JSON serializable object)
     */
    unknown | undefined;
  metadata?:
    | /**
     * A dictionary with additional data about the test example, model outputs, or just about anything else that's relevant, that you can use to help find and analyze examples later. For example, you could log the `prompt`, example's `id`, or anything else that would be useful to slice/dice later. The values in `metadata` can be any JSON-serializable type, but its keys must be strings
     */
    /**
     * A dictionary with additional data about the test example, model outputs, or just about anything else that's relevant, that you can use to help find and analyze examples later. For example, you could log the `prompt`, example's `id`, or anything else that would be useful to slice/dice later. The values in `metadata` can be any JSON-serializable type, but its keys must be strings
     */
    (| Partial<
            {
              /**
               * The model used for this example
               */
              model: /**
                 * The model used for this example
                 */
                | string
                /**
                 * The model used for this example
                 */
                | null;
            } & {
              [key: string]: any;
            }
          >
        /**
         * A dictionary with additional data about the test example, model outputs, or just about anything else that's relevant, that you can use to help find and analyze examples later. For example, you could log the `prompt`, example's `id`, or anything else that would be useful to slice/dice later. The values in `metadata` can be any JSON-serializable type, but its keys must be strings
         */
        | null
      )
    | undefined;
  tags?:
    | /**
     * A list of tags to log
     */
    /**
     * A list of tags to log
     */
    (| Array<string>
        /**
         * A list of tags to log
         */
        | null
      )
    | undefined;
  /**
   * A unique identifier used to link different dataset events together as part of a full trace. See the [tracing guide](https://www.braintrust.dev/docs/instrument) for full details on tracing
   */
  span_id: string;
  /**
   * A unique identifier for the trace this dataset event belongs to
   */
  root_span_id: string;
  is_root?:
    | /**
     * Whether this span is a root span
     */
    /**
     * Whether this span is a root span
     */
    (| boolean
        /**
         * Whether this span is a root span
         */
        | null
      )
    | undefined;
  origin?: ObjectReferenceNullishType | undefined;
  comments?:
    | /**
     * Optional list of comments attached to this event
     */
    /**
     * Optional list of comments attached to this event
     */
    (| Array<unknown>
        /**
         * Optional list of comments attached to this event
         */
        | null
      )
    | undefined;
  audit_data?:
    | /**
     * Optional list of audit entries attached to this event
     */
    /**
     * Optional list of audit entries attached to this event
     */
    (| Array<unknown>
        /**
         * Optional list of audit entries attached to this event
         */
        | null
      )
    | undefined;
  facets?:
    | /**
     * Facets for categorization (dictionary from facet id to value)
     */
    /**
     * Facets for categorization (dictionary from facet id to value)
     */
    (| {}
        /**
         * Facets for categorization (dictionary from facet id to value)
         */
        | null
      )
    | undefined;
  classifications?:
    | /**
     * Classifications for this event (dictionary from classification name to items)
     */
    /**
     * Classifications for this event (dictionary from classification name to items)
     */
    (| {}
        /**
         * Classifications for this event (dictionary from classification name to items)
         */
        | null
      )
    | undefined;
};
export type DatasetSnapshotType = {
  /**
   * Unique identifier for the dataset snapshot
   */
  id: string;
  /**
   * Unique identifier for the dataset that this snapshot belongs to
   */
  dataset_id: string;
  /**
   * Name of the dataset snapshot
   */
  name: string;
  description: string | null;
  /**
   * Transaction id of the brainstore version at the time of the snapshot
   */
  xact_id: string;
  /**
   * Date of dataset snapshot creation
   */
  created: /**
     * Date of dataset snapshot creation
     */
    | string
    /**
     * Date of dataset snapshot creation
     */
    | null;
};
export type EnvVarType = {
  /**
   * Unique identifier for the environment variable
   */
  id: string;
  /**
   * The type of the object the environment variable is scoped for
   *
   * @enum organization, project, function
   */
  object_type: "organization" | "project" | "function";
  /**
   * The id of the object the environment variable is scoped for
   */
  object_id: string;
  /**
   * The name of the environment variable
   */
  name: string;
  created?:
    | /**
     * Date of environment variable creation
     */
    /**
     * Date of environment variable creation
     */
    (| string
        /**
         * Date of environment variable creation
         */
        | null
      )
    | undefined;
  secret_updated_at?:
    | /**
     * Date of last update to the encrypted secret value itself
     */
    /**
     * Date of last update to the encrypted secret value itself
     */
    (| string
        /**
         * Date of last update to the encrypted secret value itself
         */
        | null
      )
    | undefined;
  secret_updated_by_user_id?:
    | /**
     * User id of the last update to the encrypted secret value
     */
    /**
     * User id of the last update to the encrypted secret value
     */
    (| string
        /**
         * User id of the last update to the encrypted secret value
         */
        | null
      )
    | undefined;
  used?:
    | /**
     * Date the environment variable was last used
     */
    /**
     * Date the environment variable was last used
     */
    (| string
        /**
         * Date the environment variable was last used
         */
        | null
      )
    | undefined;
  metadata?:
    | /**
     * Optional metadata associated with the environment variable when managed via the function secrets API
     */
    /**
     * Optional metadata associated with the environment variable when managed via the function secrets API
     */
    (| {}
        /**
         * Optional metadata associated with the environment variable when managed via the function secrets API
         */
        | null
      )
    | undefined;
  preview_secret?:
    | /**
     * Redacted preview of the stored secret value
     */
    /**
     * Redacted preview of the stored secret value
     */
    (| string
        /**
         * Redacted preview of the stored secret value
         */
        | null
      )
    | undefined;
  secret_type?:
    | /**
     * Optional classification for the secret (for example, the AI provider name)
     */
    /**
     * Optional classification for the secret (for example, the AI provider name)
     */
    (| string
        /**
         * Optional classification for the secret (for example, the AI provider name)
         */
        | null
      )
    | undefined;
  /**
   * The category of the secret: env_var for regular environment variables, ai_provider for AI provider API keys
   *
   * @default "env_var"
   * @enum env_var, ai_provider, sandbox_provider
   */
  secret_category: "env_var" | "ai_provider" | "sandbox_provider";
};
export type RepoInfoType =
  /**
   * Metadata about the state of the repo when the experiment was created
   */
  /**
   * Metadata about the state of the repo when the experiment was created
   */
  | Partial<{
      /**
       * SHA of most recent commit
       */
      commit: /**
         * SHA of most recent commit
         */
        | string
        /**
         * SHA of most recent commit
         */
        | null;
      /**
       * Name of the branch the most recent commit belongs to
       */
      branch: /**
         * Name of the branch the most recent commit belongs to
         */
        | string
        /**
         * Name of the branch the most recent commit belongs to
         */
        | null;
      /**
       * Name of the tag on the most recent commit
       */
      tag: /**
         * Name of the tag on the most recent commit
         */
        | string
        /**
         * Name of the tag on the most recent commit
         */
        | null;
      /**
       * Whether or not the repo had uncommitted changes when snapshotted
       */
      dirty: /**
         * Whether or not the repo had uncommitted changes when snapshotted
         */
        | boolean
        /**
         * Whether or not the repo had uncommitted changes when snapshotted
         */
        | null;
      /**
       * Name of the author of the most recent commit
       */
      author_name: /**
         * Name of the author of the most recent commit
         */
        | string
        /**
         * Name of the author of the most recent commit
         */
        | null;
      /**
       * Email of the author of the most recent commit
       */
      author_email: /**
         * Email of the author of the most recent commit
         */
        | string
        /**
         * Email of the author of the most recent commit
         */
        | null;
      /**
       * Most recent commit message
       */
      commit_message: /**
         * Most recent commit message
         */
        | string
        /**
         * Most recent commit message
         */
        | null;
      /**
       * Time of the most recent commit
       */
      commit_time: /**
         * Time of the most recent commit
         */
        | string
        /**
         * Time of the most recent commit
         */
        | null;
      /**
       * If the repo was dirty when run, this includes the diff between the current state of the repo and the most recent commit.
       */
      git_diff: /**
         * If the repo was dirty when run, this includes the diff between the current state of the repo and the most recent commit.
         */
        | string
        /**
         * If the repo was dirty when run, this includes the diff between the current state of the repo and the most recent commit.
         */
        | null;
    }>
  /**
   * Metadata about the state of the repo when the experiment was created
   */
  | null;
export type ExperimentType = {
  /**
   * Unique identifier for the experiment
   */
  id: string;
  /**
   * Unique identifier for the project that the experiment belongs under
   */
  project_id: string;
  /**
   * Name of the experiment. Within a project, experiment names are unique
   */
  name: string;
  description?:
    | /**
     * Textual description of the experiment
     */
    /**
     * Textual description of the experiment
     */
    (| string
        /**
         * Textual description of the experiment
         */
        | null
      )
    | undefined;
  created?:
    | /**
     * Date of experiment creation
     */
    /**
     * Date of experiment creation
     */
    (| string
        /**
         * Date of experiment creation
         */
        | null
      )
    | undefined;
  repo_info?: RepoInfoType | undefined;
  commit?:
    | /**
     * Commit, taken directly from `repo_info.commit`
     */
    /**
     * Commit, taken directly from `repo_info.commit`
     */
    (| string
        /**
         * Commit, taken directly from `repo_info.commit`
         */
        | null
      )
    | undefined;
  base_exp_id?:
    | /**
     * Id of default base experiment to compare against when viewing this experiment
     */
    /**
     * Id of default base experiment to compare against when viewing this experiment
     */
    (| string
        /**
         * Id of default base experiment to compare against when viewing this experiment
         */
        | null
      )
    | undefined;
  deleted_at?:
    | /**
     * Date of experiment deletion, or null if the experiment is still active
     */
    /**
     * Date of experiment deletion, or null if the experiment is still active
     */
    (| string
        /**
         * Date of experiment deletion, or null if the experiment is still active
         */
        | null
      )
    | undefined;
  dataset_id?:
    | /**
     * Identifier of the linked dataset, or null if the experiment is not linked to a dataset
     */
    /**
     * Identifier of the linked dataset, or null if the experiment is not linked to a dataset
     */
    (| string
        /**
         * Identifier of the linked dataset, or null if the experiment is not linked to a dataset
         */
        | null
      )
    | undefined;
  dataset_version?:
    | /**
     * Version number of the linked dataset the experiment was run against. This can be used to reproduce the experiment after the dataset has been modified.
     */
    /**
     * Version number of the linked dataset the experiment was run against. This can be used to reproduce the experiment after the dataset has been modified.
     */
    (| string
        /**
         * Version number of the linked dataset the experiment was run against. This can be used to reproduce the experiment after the dataset has been modified.
         */
        | null
      )
    | undefined;
  internal_metadata?:
    | /**
     * Braintrust-controlled metadata about the experiment.
     */
    /**
     * Braintrust-controlled metadata about the experiment.
     */
    (| Partial<
            {
              /**
               * BTQL filter payload used to evaluate a subset of a linked dataset.
               */
              dataset_filter: /**
                 * BTQL filter payload used to evaluate a subset of a linked dataset.
                 */
                | {}
                /**
                 * BTQL filter payload used to evaluate a subset of a linked dataset.
                 */
                | null;
            } & {
              [key: string]: any;
            }
          >
        /**
         * Braintrust-controlled metadata about the experiment.
         */
        | null
      )
    | undefined;
  parameters_id?:
    | /**
     * Identifier of the linked saved parameters object, or null if the experiment is not linked to saved parameters
     */
    /**
     * Identifier of the linked saved parameters object, or null if the experiment is not linked to saved parameters
     */
    (| string
        /**
         * Identifier of the linked saved parameters object, or null if the experiment is not linked to saved parameters
         */
        | null
      )
    | undefined;
  parameters_version?:
    | /**
     * Version number of the linked saved parameters object the experiment was run against.
     */
    /**
     * Version number of the linked saved parameters object the experiment was run against.
     */
    (| string
        /**
         * Version number of the linked saved parameters object the experiment was run against.
         */
        | null
      )
    | undefined;
  /**
   * Whether or not the experiment is public. Public experiments can be viewed by anybody inside or outside the organization
   */
  public: boolean;
  user_id?:
    | /**
     * Identifies the user who created the experiment
     */
    /**
     * Identifies the user who created the experiment
     */
    (| string
        /**
         * Identifies the user who created the experiment
         */
        | null
      )
    | undefined;
  metadata?:
    | /**
     * User-controlled metadata about the experiment
     */
    /**
     * User-controlled metadata about the experiment
     */
    (| {}
        /**
         * User-controlled metadata about the experiment
         */
        | null
      )
    | undefined;
  tags?:
    | /**
     * A list of tags for the experiment
     */
    /**
     * A list of tags for the experiment
     */
    (| Array<string>
        /**
         * A list of tags for the experiment
         */
        | null
      )
    | undefined;
};
export type SpanTypeType =
  /**
   * Type of the span, for display purposes only
   *
   * @enum llm, score, function, eval, task, tool, automation, facet, preprocessor, classifier, review
   */
  | /**
   * Type of the span, for display purposes only
   *
   * @enum llm, score, function, eval, task, tool, automation, facet, preprocessor, classifier, review
   */
  (| "llm"
      | "score"
      | "function"
      | "eval"
      | "task"
      | "tool"
      | "automation"
      | "facet"
      | "preprocessor"
      | "classifier"
      | "review"
    )
  /**
   * Type of the span, for display purposes only
   *
   * @enum llm, score, function, eval, task, tool, automation, facet, preprocessor, classifier, review
   */
  | null;
export type SpanAttributesType =
  /**
   * Human-identifying attributes of the span, such as name, type, etc.
   */
  /**
   * Human-identifying attributes of the span, such as name, type, etc.
   */
  | Partial<
      {
        /**
         * Name of the span, for display purposes only
         */
        name: /**
           * Name of the span, for display purposes only
           */
          | string
          /**
           * Name of the span, for display purposes only
           */
          | null;
        type: SpanTypeType;
        /**
         * A special value that indicates the span was generated by a scoring automation
         *
         * @enum scorer
         */
        purpose:
          | /**
           * A special value that indicates the span was generated by a scoring automation
           *
           * @enum scorer
           */
          "scorer"
          /**
           * A special value that indicates the span was generated by a scoring automation
           *
           * @enum scorer
           */
          | null;
      } & {
        [key: string]: any;
      }
    >
  /**
   * Human-identifying attributes of the span, such as name, type, etc.
   */
  | null;
export type ExperimentEventType = {
  /**
   * A unique identifier for the experiment event. If you don't provide one, Braintrust will generate one for you
   */
  id: string;
  /**
   * The transaction id of an event is unique to the network operation that processed the event insertion. Transaction ids are monotonically increasing over time and can be used to retrieve a versioned snapshot of the experiment (see the `version` parameter)
   */
  _xact_id: string;
  /**
   * The timestamp the experiment event was created
   */
  created: string;
  _pagination_key?:
    | /**
     * A stable, time-ordered key that can be used to paginate over experiment events. This field is auto-generated by Braintrust and only exists in Brainstore.
     */
    /**
     * A stable, time-ordered key that can be used to paginate over experiment events. This field is auto-generated by Braintrust and only exists in Brainstore.
     */
    (| string
        /**
         * A stable, time-ordered key that can be used to paginate over experiment events. This field is auto-generated by Braintrust and only exists in Brainstore.
         */
        | null
      )
    | undefined;
  /**
   * Unique identifier for the project that the experiment belongs under
   */
  project_id: string;
  /**
   * Unique identifier for the experiment
   */
  experiment_id: string;
  input?: /**
     * The arguments that uniquely define a test case (an arbitrary, JSON serializable object). Later on, Braintrust will use the `input` to know whether two test cases are the same between experiments, so they should not contain experiment-specific state. A simple rule of thumb is that if you run the same experiment twice, the `input` should be identical
     */
    unknown | undefined;
  output?: /**
     * The output of your application, including post-processing (an arbitrary, JSON serializable object), that allows you to determine whether the result is correct or not. For example, in an app that generates SQL queries, the `output` should be the _result_ of the SQL query generated by the model, not the query itself, because there may be multiple valid queries that answer a single question
     */
    unknown | undefined;
  expected?: /**
     * The ground truth value (an arbitrary, JSON serializable object) that you'd compare to `output` to determine if your `output` value is correct or not. Braintrust currently does not compare `output` to `expected` for you, since there are so many different ways to do that correctly. Instead, these values are just used to help you navigate your experiments while digging into analyses. However, we may later use these values to re-score outputs or fine-tune your models
     */
    unknown | undefined;
  error?: /**
     * The error that occurred, if any.
     */
    unknown | undefined;
  scores?:
    | /**
     * A dictionary of numeric values (between 0 and 1) to log. The scores should give you a variety of signals that help you determine how accurate the outputs are compared to what you expect and diagnose failures. For example, a summarization app might have one score that tells you how accurate the summary is, and another that measures the word similarity between the generated and grouth truth summary. The word similarity score could help you determine whether the summarization was covering similar concepts or not. You can use these scores to help you sort, filter, and compare experiments
     */
    /**
     * A dictionary of numeric values (between 0 and 1) to log. The scores should give you a variety of signals that help you determine how accurate the outputs are compared to what you expect and diagnose failures. For example, a summarization app might have one score that tells you how accurate the summary is, and another that measures the word similarity between the generated and grouth truth summary. The word similarity score could help you determine whether the summarization was covering similar concepts or not. You can use these scores to help you sort, filter, and compare experiments
     */
    (| {}
        /**
         * A dictionary of numeric values (between 0 and 1) to log. The scores should give you a variety of signals that help you determine how accurate the outputs are compared to what you expect and diagnose failures. For example, a summarization app might have one score that tells you how accurate the summary is, and another that measures the word similarity between the generated and grouth truth summary. The word similarity score could help you determine whether the summarization was covering similar concepts or not. You can use these scores to help you sort, filter, and compare experiments
         */
        | null
      )
    | undefined;
  metadata?:
    | /**
     * A dictionary with additional data about the test example, model outputs, or just about anything else that's relevant, that you can use to help find and analyze examples later. For example, you could log the `prompt`, example's `id`, or anything else that would be useful to slice/dice later. The values in `metadata` can be any JSON-serializable type, but its keys must be strings
     */
    /**
     * A dictionary with additional data about the test example, model outputs, or just about anything else that's relevant, that you can use to help find and analyze examples later. For example, you could log the `prompt`, example's `id`, or anything else that would be useful to slice/dice later. The values in `metadata` can be any JSON-serializable type, but its keys must be strings
     */
    (| Partial<
            {
              /**
               * The model used for this example
               */
              model: /**
                 * The model used for this example
                 */
                | string
                /**
                 * The model used for this example
                 */
                | null;
            } & {
              [key: string]: any;
            }
          >
        /**
         * A dictionary with additional data about the test example, model outputs, or just about anything else that's relevant, that you can use to help find and analyze examples later. For example, you could log the `prompt`, example's `id`, or anything else that would be useful to slice/dice later. The values in `metadata` can be any JSON-serializable type, but its keys must be strings
         */
        | null
      )
    | undefined;
  tags?:
    | /**
     * A list of tags to log
     */
    /**
     * A list of tags to log
     */
    (| Array<string>
        /**
         * A list of tags to log
         */
        | null
      )
    | undefined;
  metrics?:
    | /**
     * Metrics are numerical measurements tracking the execution of the code that produced the experiment event. Use "start" and "end" to track the time span over which the experiment event was produced
     */
    (| /**
         * Metrics are numerical measurements tracking the execution of the code that produced the experiment event. Use "start" and "end" to track the time span over which the experiment event was produced
         */
        ({} & {
            [key: string]: number;
          })
        /**
         * Metrics are numerical measurements tracking the execution of the code that produced the experiment event. Use "start" and "end" to track the time span over which the experiment event was produced
         */
        | null
      )
    | undefined;
  context?:
    | /**
     * Context is additional information about the code that produced the experiment event. It is essentially the textual counterpart to `metrics`. Use the `caller_*` attributes to track the location in code which produced the experiment event
     */
    /**
     * Context is additional information about the code that produced the experiment event. It is essentially the textual counterpart to `metrics`. Use the `caller_*` attributes to track the location in code which produced the experiment event
     */
    (| Partial<
            {
              /**
               * The function in code which created the experiment event
               */
              caller_functionname: /**
                 * The function in code which created the experiment event
                 */
                | string
                /**
                 * The function in code which created the experiment event
                 */
                | null;
              /**
               * Name of the file in code where the experiment event was created
               */
              caller_filename: /**
                 * Name of the file in code where the experiment event was created
                 */
                | string
                /**
                 * Name of the file in code where the experiment event was created
                 */
                | null;
              /**
               * Line of code where the experiment event was created
               */
              caller_lineno: /**
                 * Line of code where the experiment event was created
                 */
                | number
                /**
                 * Line of code where the experiment event was created
                 */
                | null;
            } & {
              [key: string]: any;
            }
          >
        /**
         * Context is additional information about the code that produced the experiment event. It is essentially the textual counterpart to `metrics`. Use the `caller_*` attributes to track the location in code which produced the experiment event
         */
        | null
      )
    | undefined;
  /**
   * A unique identifier used to link different experiment events together as part of a full trace. See the [tracing guide](https://www.braintrust.dev/docs/instrument) for full details on tracing
   */
  span_id: string;
  span_parents?:
    | /**
     * An array of the parent `span_ids` of this experiment event. This should be empty for the root span of a trace, and should most often contain just one parent element for subspans
     */
    /**
     * An array of the parent `span_ids` of this experiment event. This should be empty for the root span of a trace, and should most often contain just one parent element for subspans
     */
    (| Array<string>
        /**
         * An array of the parent `span_ids` of this experiment event. This should be empty for the root span of a trace, and should most often contain just one parent element for subspans
         */
        | null
      )
    | undefined;
  /**
   * A unique identifier for the trace this experiment event belongs to
   */
  root_span_id: string;
  span_attributes?: SpanAttributesType | undefined;
  is_root?:
    | /**
     * Whether this span is a root span
     */
    /**
     * Whether this span is a root span
     */
    (| boolean
        /**
         * Whether this span is a root span
         */
        | null
      )
    | undefined;
  origin?: ObjectReferenceNullishType | undefined;
  comments?:
    | /**
     * Optional list of comments attached to this event
     */
    /**
     * Optional list of comments attached to this event
     */
    (| Array<unknown>
        /**
         * Optional list of comments attached to this event
         */
        | null
      )
    | undefined;
  audit_data?:
    | /**
     * Optional list of audit entries attached to this event
     */
    /**
     * Optional list of audit entries attached to this event
     */
    (| Array<unknown>
        /**
         * Optional list of audit entries attached to this event
         */
        | null
      )
    | undefined;
  facets?:
    | /**
     * Facets for categorization (dictionary from facet id to value)
     */
    /**
     * Facets for categorization (dictionary from facet id to value)
     */
    (| {}
        /**
         * Facets for categorization (dictionary from facet id to value)
         */
        | null
      )
    | undefined;
  classifications?:
    | /**
     * Classifications for this event (dictionary from classification name to items)
     */
    /**
     * Classifications for this event (dictionary from classification name to items)
     */
    (| {}
        /**
         * Classifications for this event (dictionary from classification name to items)
         */
        | null
      )
    | undefined;
};
export type ExtendedSavedFunctionIdType =
  | {
      /**
       * @enum function
       */
      type: "function";
      id: string;
      version?: /**
         * The version of the function
         */
        string | undefined;
    }
  | {
      /**
       * @enum global
       */
      type: "global";
      name: string;
      function_type: FunctionTypeEnumType;
    }
  | {
      /**
       * @enum slug
       */
      type: "slug";
      project_id: string;
      slug: string;
    };
export type FacetDataType = {
  /**
   * @enum facet
   */
  type: "facet";
  preprocessor?: FacetPreprocessorIdType | undefined;
  /**
   * The prompt to use for LLM extraction. The preprocessed text will be provided as context.
   */
  prompt: string;
  model?: /**
     * The model to use for facet extraction
     */
    string | undefined;
  embedding_model?: /**
     * The embedding model to use for vectorizing facet results.
     */
    string | undefined;
  no_match_pattern?: /**
     * Regex pattern to identify outputs that do not match the facet. If the output matches, the facet will be saved as 'no_match'
     */
    string | undefined;
};
export type PromptBlockDataNullishType =
  | {
      /**
       * @enum chat
       */
      type: "chat";
      messages: Array<ChatCompletionMessageParamType>;
      tools?: string | undefined;
    }
  | {
      /**
       * @enum completion
       */
      type: "completion";
      content: string;
    }
  | null;
export type ModelParamsType =
  | Partial<
      {
        use_cache: boolean;
        reasoning_enabled: boolean;
        reasoning_budget: number;
        temperature: number;
        top_p: number;
        max_tokens: number;
        /**
         * The successor to max_tokens
         */
        max_completion_tokens: number;
        frequency_penalty: number;
        presence_penalty: number;
        response_format: ResponseFormatNullishType;
        tool_choice:
          | /**
           * @enum auto
           */
          "auto"
          /**
           * @enum none
           */
          | "none"
          /**
           * @enum required
           */
          | "required"
          | {
              /**
               * @enum function
               */
              type: "function";
              function: {
                name: string;
              };
            };
        function_call:
          | /**
           * @enum auto
           */
          "auto"
          /**
           * @enum none
           */
          | "none"
          | {
              name: string;
            };
        n: number;
        stop: Array<string>;
        /**
         * @enum none, minimal, low, medium, high
         */
        reasoning_effort: "none" | "minimal" | "low" | "medium" | "high";
        /**
         * @enum low, medium, high
         */
        verbosity: "low" | "medium" | "high";
      } & {
        [key: string]: any;
      }
    >
  | ({
      use_cache?: boolean | undefined;
      reasoning_enabled?: boolean | undefined;
      reasoning_budget?: number | undefined;
      max_tokens: number;
      temperature: number;
      top_p?: number | undefined;
      top_k?: number | undefined;
      stop_sequences?: Array<string> | undefined;
      max_tokens_to_sample?: /**
         * This is a legacy parameter that should not be used.
         */
        number | undefined;
    } & {
      [key: string]: any;
    })
  | Partial<
      {
        use_cache: boolean;
        reasoning_enabled: boolean;
        reasoning_budget: number;
        temperature: number;
        maxOutputTokens: number;
        topP: number;
        topK: number;
      } & {
        [key: string]: any;
      }
    >
  | Partial<
      {
        use_cache: boolean;
        reasoning_enabled: boolean;
        reasoning_budget: number;
        temperature: number;
        topK: number;
      } & {
        [key: string]: any;
      }
    >
  | Partial<
      {
        use_cache: boolean;
        reasoning_enabled: boolean;
        reasoning_budget: number;
      } & {
        [key: string]: any;
      }
    >;
export type PromptOptionsNullishType = Partial<{
  model: string;
  params: ModelParamsType;
  position: string;
  endpoint_name: string | null;
}> | null;
export type PromptParserNullishType = {
  /**
   * @enum llm_classifier
   */
  type: "llm_classifier";
  use_cot: boolean;
  choice_scores?: /**
     * Map of choices to scores (0-1). Used by scorers.
     */
    {} | undefined;
  choice?: /**
     * List of valid choices without score mapping. Used by classifiers that deposit output to tags.
     */
    Array<string> | undefined;
  allow_no_match?: /**
     * If true, adds a 'No match' option. When selected, no tag is deposited.
     */
    boolean | undefined;
  allow_skip?: /**
     * If true, adds a 'Skip' option. When selected, the scorer returns null.
     */
    boolean | undefined;
} | null;
export type PreprocessorSavedFunctionIdType =
  /**
   * For prompt-backed functions: the preprocessor function to use for trace template variables. Set to null to disable preprocessing. If omitted, the traced project's default preprocessor will be used, falling back to the global 'thread' preprocessor.
   */
  | {
      /**
       * @enum function
       */
      type: "function";
      id: string;
      version?: /**
         * The version of the function
         */
        string | undefined;
    }
  | {
      /**
       * @enum global
       */
      type: "global";
      name: string;
      /**
       * The type of global function. Defaults to 'preprocessor'.
       *
       * @default "preprocessor"
       * @enum preprocessor
       */
      function_type: "preprocessor";
    }
  | null;
export type PromptDataNullishType =
  /**
   * The prompt, model, and its parameters
   */
  /**
   * The prompt, model, and its parameters
   */
  | Partial<{
      prompt: PromptBlockDataNullishType;
      options: PromptOptionsNullishType;
      parser: PromptParserNullishType;
      preprocessor: PreprocessorSavedFunctionIdType;
      tool_functions: Array<SavedFunctionIdType> | null;
      /**
       * @enum mustache, nunjucks, none
       */
      template_format:
        | /**
         * @enum mustache, nunjucks, none
         */
        ("mustache" | "nunjucks" | "none")
        /**
         * @enum mustache, nunjucks, none
         */
        | null;
      mcp: {} | null;
      origin: Partial<{
        prompt_id: string;
        project_id: string;
        prompt_version: string;
      }> | null;
    }>
  /**
   * The prompt, model, and its parameters
   */
  | null;
export type FunctionTypeEnumNullishType =
  /**
   * @enum llm, scorer, task, tool, custom_view, preprocessor, facet, classifier, tag, parameters, sandbox
   */
  | /**
   * @enum llm, scorer, task, tool, custom_view, preprocessor, facet, classifier, tag, parameters, sandbox
   */
  (| "llm"
      | "scorer"
      | "task"
      | "tool"
      | "custom_view"
      | "preprocessor"
      | "facet"
      | "classifier"
      | "tag"
      | "parameters"
      | "sandbox"
    )
  /**
   * @enum llm, scorer, task, tool, custom_view, preprocessor, facet, classifier, tag, parameters, sandbox
   */
  | null;
export type FunctionIdRefType = Partial<
  {} & {
    [key: string]: any;
  }
>;
export type PromptBlockDataType =
  | {
      /**
       * @enum chat
       */
      type: "chat";
      messages: Array<ChatCompletionMessageParamType>;
      tools?: string | undefined;
    }
  | {
      /**
       * @enum completion
       */
      type: "completion";
      content: string;
    };
export type GraphNodeType =
  | {
      description?:
        | /**
         * The description of the node
         */
        /**
         * The description of the node
         */
        (| string
            /**
             * The description of the node
             */
            | null
          )
        | undefined;
      position?:
        | /**
         * The position of the node
         */
        /**
         * The position of the node
         */
        (| {
                /**
                 * The x position of the node
                 */
                x: number;
                /**
                 * The y position of the node
                 */
                y: number;
              }
            /**
             * The position of the node
             */
            | null
          )
        | undefined;
      /**
       * @enum function
       */
      type: "function";
      function: FunctionIdRefType;
    }
  | {
      description?:
        | /**
         * The description of the node
         */
        /**
         * The description of the node
         */
        (| string
            /**
             * The description of the node
             */
            | null
          )
        | undefined;
      position?:
        | /**
         * The position of the node
         */
        /**
         * The position of the node
         */
        (| {
                /**
                 * The x position of the node
                 */
                x: number;
                /**
                 * The y position of the node
                 */
                y: number;
              }
            /**
             * The position of the node
             */
            | null
          )
        | undefined;
      /**
       * The input to the graph
       *
       * @enum input
       */
      type: "input";
    }
  | {
      description?:
        | /**
         * The description of the node
         */
        /**
         * The description of the node
         */
        (| string
            /**
             * The description of the node
             */
            | null
          )
        | undefined;
      position?:
        | /**
         * The position of the node
         */
        /**
         * The position of the node
         */
        (| {
                /**
                 * The x position of the node
                 */
                x: number;
                /**
                 * The y position of the node
                 */
                y: number;
              }
            /**
             * The position of the node
             */
            | null
          )
        | undefined;
      /**
       * The output of the graph
       *
       * @enum output
       */
      type: "output";
    }
  | {
      description?:
        | /**
         * The description of the node
         */
        /**
         * The description of the node
         */
        (| string
            /**
             * The description of the node
             */
            | null
          )
        | undefined;
      position?:
        | /**
         * The position of the node
         */
        /**
         * The position of the node
         */
        (| {
                /**
                 * The x position of the node
                 */
                x: number;
                /**
                 * The y position of the node
                 */
                y: number;
              }
            /**
             * The position of the node
             */
            | null
          )
        | undefined;
      /**
       * @enum literal
       */
      type: "literal";
      value?: /**
         * A literal value to be returned
         */
        unknown | undefined;
    }
  | {
      description?:
        | /**
         * The description of the node
         */
        /**
         * The description of the node
         */
        (| string
            /**
             * The description of the node
             */
            | null
          )
        | undefined;
      position?:
        | /**
         * The position of the node
         */
        /**
         * The position of the node
         */
        (| {
                /**
                 * The x position of the node
                 */
                x: number;
                /**
                 * The y position of the node
                 */
                y: number;
              }
            /**
             * The position of the node
             */
            | null
          )
        | undefined;
      /**
       * @enum btql
       */
      type: "btql";
      /**
       * A BTQL expression to be evaluated
       */
      expr: string;
    }
  | {
      description?:
        | /**
         * The description of the node
         */
        /**
         * The description of the node
         */
        (| string
            /**
             * The description of the node
             */
            | null
          )
        | undefined;
      position?:
        | /**
         * The position of the node
         */
        /**
         * The position of the node
         */
        (| {
                /**
                 * The x position of the node
                 */
                x: number;
                /**
                 * The y position of the node
                 */
                y: number;
              }
            /**
             * The position of the node
             */
            | null
          )
        | undefined;
      /**
       * @enum gate
       */
      type: "gate";
      condition?:
        | /**
         * A BTQL expression to be evaluated
         */
        /**
         * A BTQL expression to be evaluated
         */
        (| string
            /**
             * A BTQL expression to be evaluated
             */
            | null
          )
        | undefined;
    }
  | {
      description?:
        | /**
         * The description of the node
         */
        /**
         * The description of the node
         */
        (| string
            /**
             * The description of the node
             */
            | null
          )
        | undefined;
      position?:
        | /**
         * The position of the node
         */
        /**
         * The position of the node
         */
        (| {
                /**
                 * The x position of the node
                 */
                x: number;
                /**
                 * The y position of the node
                 */
                y: number;
              }
            /**
             * The position of the node
             */
            | null
          )
        | undefined;
      /**
       * @enum aggregator
       */
      type: "aggregator";
    }
  | {
      description?:
        | /**
         * The description of the node
         */
        /**
         * The description of the node
         */
        (| string
            /**
             * The description of the node
             */
            | null
          )
        | undefined;
      position?:
        | /**
         * The position of the node
         */
        /**
         * The position of the node
         */
        (| {
                /**
                 * The x position of the node
                 */
                x: number;
                /**
                 * The y position of the node
                 */
                y: number;
              }
            /**
             * The position of the node
             */
            | null
          )
        | undefined;
      /**
       * @enum prompt_template
       */
      type: "prompt_template";
      prompt: PromptBlockDataType;
    };
export type GraphEdgeType = {
  source: {
    /**
     * The id of the node in the graph
     *
     * @maxLength 1024
     */
    node: string;
    variable: string;
  };
  target: {
    /**
     * The id of the node in the graph
     *
     * @maxLength 1024
     */
    node: string;
    variable: string;
  };
  /**
   * The purpose of the edge
   *
   * @enum control, data, messages
   */
  purpose: "control" | "data" | "messages";
};
export type GraphDataType = {
  /**
   * @enum graph
   */
  type: "graph";
  nodes: {};
  edges: {};
};
export type FunctionDataType =
  | {
      /**
       * @enum prompt
       */
      type: "prompt";
    }
  | {
      /**
       * @enum code
       */
      type: "code";
      data:
        | ({
            /**
             * @enum bundle
             */
            type: "bundle";
          } & CodeBundleType)
        | {
            /**
             * @enum inline
             */
            type: "inline";
            runtime_context: {
              /**
               * @enum node, python, browser, quickjs
               */
              runtime: "node" | "python" | "browser" | "quickjs";
              version: string;
            };
            code: string;
            code_hash?: /**
               * SHA256 hash of the code, computed at save time
               */
              string | undefined;
          };
    }
  | GraphDataType
  /**
   * A remote eval to run
   */
  | {
      /**
       * @enum remote_eval
       */
      type: "remote_eval";
      endpoint: string;
      eval_name: string;
      parameters: {};
      parameters_version?:
        | /**
         * The version (transaction ID) of the parameters being used
         */
        /**
         * The version (transaction ID) of the parameters being used
         */
        (| string
            /**
             * The version (transaction ID) of the parameters being used
             */
            | null
          )
        | undefined;
    }
  | {
      /**
       * @enum global
       */
      type: "global";
      name: string;
      function_type: FunctionTypeEnumType;
      config?:
        | /**
         * Configuration options to pass to the global function (e.g., for preprocessor customization)
         */
        /**
         * Configuration options to pass to the global function (e.g., for preprocessor customization)
         */
        (| {}
            /**
             * Configuration options to pass to the global function (e.g., for preprocessor customization)
             */
            | null
          )
        | undefined;
    }
  | FacetDataType
  | BatchedFacetDataType
  | {
      /**
       * @enum parameters
       */
      type: "parameters";
      /**
       * The parameters data
       */
      data: {};
      /**
       * JSON Schema format for parameters
       */
      __schema: {
        /**
         * @enum object
         */
        type: "object";
        properties: {};
        required?: Array<string> | undefined;
        additionalProperties?: boolean | undefined;
      };
    }
  | (TopicMapDataType & unknown);
export type FunctionType = {
  /**
   * Unique identifier for the prompt
   */
  id: string;
  /**
   * The transaction id of an event is unique to the network operation that processed the event insertion. Transaction ids are monotonically increasing over time and can be used to retrieve a versioned snapshot of the prompt (see the `version` parameter)
   */
  _xact_id: string;
  /**
   * Unique identifier for the project that the prompt belongs under
   */
  project_id: string;
  /**
   * A literal 'p' which identifies the object as a project prompt
   *
   * @enum p
   */
  log_id: "p";
  /**
   * Unique identifier for the organization
   */
  org_id: string;
  /**
   * Name of the prompt
   */
  name: string;
  /**
   * Unique identifier for the prompt
   */
  slug: string;
  description?:
    | /**
     * Textual description of the prompt
     */
    /**
     * Textual description of the prompt
     */
    (| string
        /**
         * Textual description of the prompt
         */
        | null
      )
    | undefined;
  created?:
    | /**
     * Date of prompt creation
     */
    /**
     * Date of prompt creation
     */
    (| string
        /**
         * Date of prompt creation
         */
        | null
      )
    | undefined;
  prompt_data?: PromptDataNullishType | undefined;
  tags?:
    | /**
     * A list of tags for the prompt
     */
    /**
     * A list of tags for the prompt
     */
    (| Array<string>
        /**
         * A list of tags for the prompt
         */
        | null
      )
    | undefined;
  metadata?:
    | /**
     * User-controlled metadata about the prompt
     */
    /**
     * User-controlled metadata about the prompt
     */
    (| {}
        /**
         * User-controlled metadata about the prompt
         */
        | null
      )
    | undefined;
  function_type?: FunctionTypeEnumNullishType | undefined;
  function_data: FunctionDataType;
  origin?:
    | ({
        object_type: AclObjectTypeType & string;
        /**
         * Id of the object the function is originating from
         */
        object_id: string;
        internal?:
          | /**
           * The function exists for internal purposes and should not be displayed in the list of functions.
           */
          /**
           * The function exists for internal purposes and should not be displayed in the list of functions.
           */
          (| boolean
              /**
               * The function exists for internal purposes and should not be displayed in the list of functions.
               */
              | null
            )
          | undefined;
      } | null)
    | undefined;
  function_schema?:
    | /**
     * JSON schema for the function's parameters and return type
     */
    /**
     * JSON schema for the function's parameters and return type
     */
    (| Partial<{
            parameters: unknown;
            returns: unknown;
          }>
        /**
         * JSON schema for the function's parameters and return type
         */
        | null
      )
    | undefined;
};
export type FunctionFormatType =
  /**
   * @enum llm, code, global, graph, topic_map
   */
  "llm" | "code" | "global" | "graph" | "topic_map";
export type PromptDataType = Partial<{
  prompt: PromptBlockDataNullishType;
  options: PromptOptionsNullishType;
  parser: PromptParserNullishType;
  preprocessor: PreprocessorSavedFunctionIdType;
  tool_functions: Array<SavedFunctionIdType> | null;
  /**
   * @enum mustache, nunjucks, none
   */
  template_format:
    | /**
     * @enum mustache, nunjucks, none
     */
    ("mustache" | "nunjucks" | "none")
    /**
     * @enum mustache, nunjucks, none
     */
    | null;
  mcp: {} | null;
  origin: Partial<{
    prompt_id: string;
    project_id: string;
    prompt_version: string;
  }> | null;
}>;
export type FunctionIdType =
  /**
   * Options for identifying a function
   */
  /**
   * Function id
   */
  | {
      /**
       * The ID of the function
       */
      function_id: string;
      version?: /**
         * The version of the function
         */
        string | undefined;
    }
  /**
   * Project name and slug
   */
  | {
      /**
       * The name of the project containing the function
       */
      project_name: string;
      /**
       * The slug of the function
       */
      slug: string;
      version?: /**
         * The version of the function
         */
        string | undefined;
    }
  /**
   * Global function name
   */
  | {
      /**
       * The name of the global function. Currently, the global namespace includes the functions in autoevals
       */
      global_function: string;
      function_type: FunctionTypeEnumType;
    }
  /**
   * Prompt session id
   */
  | {
      /**
       * The ID of the prompt session
       */
      prompt_session_id: string;
      /**
       * The ID of the function in the prompt session
       */
      prompt_session_function_id: string;
      version?: /**
         * The version of the function
         */
        string | undefined;
    }
  /**
   * Inline code function
   */
  | {
      inline_context: {
        /**
         * @enum node, python, browser, quickjs
         */
        runtime: "node" | "python" | "browser" | "quickjs";
        version: string;
      };
      /**
       * The inline code to execute
       */
      code: string;
      function_type?:
        | (FunctionTypeEnumType &
            /**
             * The function type for inline code. Required when invoking inline preprocessors.
             */ unknown)
        | undefined;
      name?:
        | /**
         * The name of the inline code function
         */
        /**
         * The name of the inline code function
         */
        (| string
            /**
             * The name of the inline code function
             */
            | null
          )
        | undefined;
    }
  /**
   * Inline function definition
   */
  | {
      inline_prompt?: PromptDataType | undefined;
      inline_function: {};
      function_type: FunctionTypeEnumType;
      name?:
        | /**
         * The name of the inline function
         */
        /**
         * The name of the inline function
         */
        (| string
            /**
             * The name of the inline function
             */
            | null
          )
        | undefined;
    }
  /**
   * Inline prompt definition
   */
  | {
      inline_prompt: PromptDataType;
      function_type: FunctionTypeEnumType;
      name?:
        | /**
         * The name of the inline prompt
         */
        /**
         * The name of the inline prompt
         */
        (| string
            /**
             * The name of the inline prompt
             */
            | null
          )
        | undefined;
    };
export type FunctionObjectTypeType =
  /**
   * @enum prompt, tool, scorer, task, workflow, custom_view, preprocessor, facet, classifier, parameters, sandbox
   */
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
export type FunctionOutputTypeType =
  /**
   * @enum completion, score, facet, classification, any
   */
  "completion" | "score" | "facet" | "classification" | "any";
export type GitMetadataSettingsType = {
  /**
   * @enum all, none, some
   */
  collect: "all" | "none" | "some";
  fields?:
    | Array<
        /**
         * @enum commit, branch, tag, dirty, author_name, author_email, commit_message, commit_time, git_diff
         */
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
};
export type GroupType = {
  /**
   * Unique identifier for the group
   */
  id: string;
  /**
     * Unique id for the organization that the group belongs under
    
    It is forbidden to change the org after creating a group
     */
  org_id: string;
  user_id?:
    | /**
     * Identifies the user who created the group
     */
    /**
     * Identifies the user who created the group
     */
    (| string
        /**
         * Identifies the user who created the group
         */
        | null
      )
    | undefined;
  created?:
    | /**
     * Date of group creation
     */
    /**
     * Date of group creation
     */
    (| string
        /**
         * Date of group creation
         */
        | null
      )
    | undefined;
  /**
   * Name of the group
   */
  name: string;
  description?:
    | /**
     * Textual description of the group
     */
    /**
     * Textual description of the group
     */
    (| string
        /**
         * Textual description of the group
         */
        | null
      )
    | undefined;
  deleted_at?:
    | /**
     * Date of group deletion, or null if the group is still active
     */
    /**
     * Date of group deletion, or null if the group is still active
     */
    (| string
        /**
         * Date of group deletion, or null if the group is still active
         */
        | null
      )
    | undefined;
  member_users?:
    | /**
     * Ids of users which belong to this group
     */
    /**
     * Ids of users which belong to this group
     */
    (| Array<string>
        /**
         * Ids of users which belong to this group
         */
        | null
      )
    | undefined;
  member_groups?:
    | /**
     * Ids of the groups this group inherits from
    
    An inheriting group has all the users contained in its member groups, as well as all of their inherited users
     */
    /**
     * Ids of the groups this group inherits from
    
    An inheriting group has all the users contained in its member groups, as well as all of their inherited users
     */
    (| Array<string> /**
     * Ids of the groups this group inherits from
    
    An inheriting group has all the users contained in its member groups, as well as all of their inherited users
     */
        | null
      )
    | undefined;
};
export type GroupScopeType = {
  /**
   * @enum group
   */
  type: "group";
  /**
   * Field path to group by, e.g. metadata.session_id
   */
  group_by: string;
  interval_seconds?: /**
     * Maximum time range to include when constructing a group
     *
     * @minimum 1
     */
    number | undefined;
  max_traces?: /**
     * Maximum number of traces to include when constructing a group (default/max: 64)
     *
     * @minimum 1
     * @maximum 64
     */
    number | undefined;
  /**
   * Which trace or traces to write grouped scorer results to
   *
   * @enum first, each
   */
  placement: "first" | "each";
  idle_seconds?: /**
     * Optional: trigger after this many seconds of inactivity
     */
    number | undefined;
};
export type IfExistsType =
  /**
   * @enum error, ignore, replace
   */
  "error" | "ignore" | "replace";
export type ImageRenderingModeType =
  /**
   * Controls how images are rendered in the UI: 'auto' loads images automatically, 'click_to_load' shows a placeholder until clicked, 'blocked' prevents image loading entirely
   *
   * @enum auto, click_to_load, blocked
   */
  | /**
   * Controls how images are rendered in the UI: 'auto' loads images automatically, 'click_to_load' shows a placeholder until clicked, 'blocked' prevents image loading entirely
   *
   * @enum auto, click_to_load, blocked
   */
  ("auto" | "click_to_load" | "blocked")
  /**
   * Controls how images are rendered in the UI: 'auto' loads images automatically, 'click_to_load' shows a placeholder until clicked, 'blocked' prevents image loading entirely
   *
   * @enum auto, click_to_load, blocked
   */
  | null;
export type InvokeParentType =
  /**
   * Options for tracing the function call
   */
  /**
   * Span parent properties
   */
  | {
      /**
       * @enum project_logs, experiment, playground_logs
       */
      object_type: "project_logs" | "experiment" | "playground_logs";
      /**
       * The id of the container object you are logging to
       */
      object_id: string;
      row_ids?:
        | /**
         * Identifiers for the row to to log a subspan under
         */
        /**
         * Identifiers for the row to to log a subspan under
         */
        (| {
                /**
                 * The id of the row
                 */
                id: string;
                /**
                 * The span_id of the row
                 */
                span_id: string;
                /**
                 * The root_span_id of the row
                 */
                root_span_id: string;
              }
            /**
             * Identifiers for the row to to log a subspan under
             */
            | null
          )
        | undefined;
      propagated_event?:
        | /**
         * Include these properties in every span created under this parent
         */
        /**
         * Include these properties in every span created under this parent
         */
        (| {}
            /**
             * Include these properties in every span created under this parent
             */
            | null
          )
        | undefined;
    }
  /**
   * The parent's span identifier, created by calling `.export()` on a span
   */
  | string;
export type StreamingModeType =
  /**
   * The mode format of the returned value (defaults to 'auto')
   *
   * @enum auto, parallel, json, text
   */
  | /**
   * The mode format of the returned value (defaults to 'auto')
   *
   * @enum auto, parallel, json, text
   */
  ("auto" | "parallel" | "json" | "text")
  /**
   * The mode format of the returned value (defaults to 'auto')
   *
   * @enum auto, parallel, json, text
   */
  | null;
export type InvokeFunctionType =
  /**
   * Options for identifying a function
   */
  FunctionIdType &
    Partial<{
      /**
       * Argument to the function, which can be any JSON serializable value
       */
      input: unknown;
      /**
       * The expected output of the function
       */
      expected: unknown;
      /**
       * Any relevant metadata. This will be logged and available as the `metadata` argument.
       */
      metadata: /**
         * Any relevant metadata. This will be logged and available as the `metadata` argument.
         */
        | {}
        /**
         * Any relevant metadata. This will be logged and available as the `metadata` argument.
         */
        | null;
      /**
       * Any relevant tags to log on the span.
       */
      tags: /**
         * Any relevant tags to log on the span.
         */
        | Array<string>
        /**
         * Any relevant tags to log on the span.
         */
        | null;
      /**
       * If the function is an LLM, additional messages to pass along to it
       */
      messages: Array<ChatCompletionMessageParamType>;
      parent: InvokeParentType;
      /**
       * Whether to stream the response. If true, results will be returned in the Braintrust SSE format.
       */
      stream: /**
         * Whether to stream the response. If true, results will be returned in the Braintrust SSE format.
         */
        | boolean
        /**
         * Whether to stream the response. If true, results will be returned in the Braintrust SSE format.
         */
        | null;
      mode: StreamingModeType;
      /**
       * If true, throw an error if one of the variables in the prompt is not present in the input
       */
      strict: /**
         * If true, throw an error if one of the variables in the prompt is not present in the input
         */
        | boolean
        /**
         * If true, throw an error if one of the variables in the prompt is not present in the input
         */
        | null;
      /**
       * Map of MCP server URL to auth credentials
       */
      mcp_auth: {};
      /**
       * Partial function definition to merge with the function being invoked. Fields are validated against the function type's schema at runtime. For facets: { preprocessor?, prompt?, model? }. For prompts: { model?, ... }.
       */
      overrides: /**
         * Partial function definition to merge with the function being invoked. Fields are validated against the function type's schema at runtime. For facets: { preprocessor?, prompt?, model? }. For prompts: { model?, ... }.
         */
        | {}
        /**
         * Partial function definition to merge with the function being invoked. Fields are validated against the function type's schema at runtime. For facets: { preprocessor?, prompt?, model? }. For prompts: { model?, ... }.
         */
        | null;
      /**
       * Name of the AI provider secret to pin this invocation to.
       */
      endpoint_name: /**
         * Name of the AI provider secret to pin this invocation to.
         */
        | string
        /**
         * Name of the AI provider secret to pin this invocation to.
         */
        | null;
    }>;
export type MCPServerType = {
  /**
   * Unique identifier for the MCP server
   */
  id: string;
  /**
   * Unique identifier for the project that the MCP server belongs under
   */
  project_id: string;
  user_id?:
    | /**
     * Identifies the user who created the MCP server
     */
    /**
     * Identifies the user who created the MCP server
     */
    (| string
        /**
         * Identifies the user who created the MCP server
         */
        | null
      )
    | undefined;
  created?:
    | /**
     * Date of MCP server creation
     */
    /**
     * Date of MCP server creation
     */
    (| string
        /**
         * Date of MCP server creation
         */
        | null
      )
    | undefined;
  deleted_at?:
    | /**
     * Date of MCP server deletion, or null if the MCP server is still active
     */
    /**
     * Date of MCP server deletion, or null if the MCP server is still active
     */
    (| string
        /**
         * Date of MCP server deletion, or null if the MCP server is still active
         */
        | null
      )
    | undefined;
  /**
   * Name of the MCP server. Within a project, MCP server names are unique
   */
  name: string;
  description?:
    | /**
     * Textual description of the MCP server
     */
    /**
     * Textual description of the MCP server
     */
    (| string
        /**
         * Textual description of the MCP server
         */
        | null
      )
    | undefined;
  /**
   * URL of the MCP server endpoint
   */
  url: string;
};
export type MessageRoleType =
  /**
   * @enum system, user, assistant, function, tool, model, developer
   */
  "system" | "user" | "assistant" | "function" | "tool" | "model" | "developer";
export type NullableSavedFunctionIdType =
  /**
   * Default preprocessor for this project. When set, functions that use preprocessors will use this instead of their built-in default.
   */
  | {
      /**
       * @enum function
       */
      type: "function";
      id: string;
      version?: /**
         * The version of the function
         */
        string | undefined;
    }
  | {
      /**
       * @enum global
       */
      type: "global";
      name: string;
      function_type: FunctionTypeEnumType;
    }
  | null;
export type ObjectReferenceType = {
  /**
   * Type of the object the event is originating from.
   *
   * @enum project_logs, experiment, dataset, prompt, function, prompt_session
   */
  object_type:
    | "project_logs"
    | "experiment"
    | "dataset"
    | "prompt"
    | "function"
    | "prompt_session";
  /**
   * ID of the object the event is originating from.
   */
  object_id: string;
  /**
   * ID of the original event.
   */
  id: string;
  _xact_id?:
    | /**
     * Transaction ID of the original event.
     */
    /**
     * Transaction ID of the original event.
     */
    (| string
        /**
         * Transaction ID of the original event.
         */
        | null
      )
    | undefined;
  created?:
    | /**
     * Created timestamp of the original event. Used to help sort in the UI
     */
    /**
     * Created timestamp of the original event. Used to help sort in the UI
     */
    (| string
        /**
         * Created timestamp of the original event. Used to help sort in the UI
         */
        | null
      )
    | undefined;
};
export type SpanScopeType = {
  /**
   * @enum span
   */
  type: "span";
};
export type TraceScopeType = {
  /**
   * @enum trace
   */
  type: "trace";
  idle_seconds?: /**
     * Consider trace complete after this many seconds of inactivity (default: 30)
     */
    number | undefined;
};
export type OnlineScoreConfigType = {
  status?: AutomationStatusType | undefined;
  /**
   * The sampling rate for online scoring
   *
   * @minimum 0
   * @maximum 1
   */
  sampling_rate: number;
  /**
   * The list of functions to run for online scoring. Can include scorers, facets, or other function types.
   */
  scorers: Array<SavedFunctionIdType>;
  btql_filter?:
    | /**
     * Filter logs using BTQL
     */
    /**
     * Filter logs using BTQL
     */
    (| string
        /**
         * Filter logs using BTQL
         */
        | null
      )
    | undefined;
  apply_to_root_span?:
    | /**
     * Whether to trigger online scoring on the root span of each trace. Only applies when scope is 'span' or unset.
     */
    /**
     * Whether to trigger online scoring on the root span of each trace. Only applies when scope is 'span' or unset.
     */
    (| boolean
        /**
         * Whether to trigger online scoring on the root span of each trace. Only applies when scope is 'span' or unset.
         */
        | null
      )
    | undefined;
  apply_to_span_names?:
    | /**
     * Trigger online scoring on any spans with a name in this list. Only applies when scope is 'span' or unset.
     */
    /**
     * Trigger online scoring on any spans with a name in this list. Only applies when scope is 'span' or unset.
     */
    (| Array<string>
        /**
         * Trigger online scoring on any spans with a name in this list. Only applies when scope is 'span' or unset.
         */
        | null
      )
    | undefined;
  skip_logging?:
    | /**
     * Whether to skip adding scorer spans when computing scores
     */
    /**
     * Whether to skip adding scorer spans when computing scores
     */
    (| boolean
        /**
         * Whether to skip adding scorer spans when computing scores
         */
        | null
      )
    | undefined;
  scope?:
    | /**
     * The scope at which to run the functions. Defaults to span-level execution.
     */
    (SpanScopeType | TraceScopeType | GroupScopeType | null)
    | undefined;
} | null;
export type OrganizationType = {
  /**
   * Unique identifier for the organization
   */
  id: string;
  /**
   * Name of the organization
   */
  name: string;
  api_url?: (string | null) | undefined;
  is_universal_api?: (boolean | null) | undefined;
  is_dataplane_private?: (boolean | null) | undefined;
  proxy_url?: (string | null) | undefined;
  realtime_url?: (string | null) | undefined;
  created?:
    | /**
     * Date of organization creation
     */
    /**
     * Date of organization creation
     */
    (| string
        /**
         * Date of organization creation
         */
        | null
      )
    | undefined;
  image_rendering_mode?: ImageRenderingModeType | undefined;
};
export type RetentionObjectTypeType =
  /**
   * The object type that the retention policy applies to
   *
   * @enum project_logs, experiment, dataset
   */
  "project_logs" | "experiment" | "dataset";
export type OrgAutomationType = {
  /**
   * Unique identifier for the project automation
   */
  id: string;
  /**
   * Unique identifier for the organization that the org automation belongs under
   */
  org_id: string;
  user_id?:
    | /**
     * Identifies the user who created the project automation
     */
    /**
     * Identifies the user who created the project automation
     */
    (| string
        /**
         * Identifies the user who created the project automation
         */
        | null
      )
    | undefined;
  created?:
    | /**
     * Date of project automation creation
     */
    /**
     * Date of project automation creation
     */
    (| string
        /**
         * Date of project automation creation
         */
        | null
      )
    | undefined;
  /**
   * Name of the project automation
   */
  name: string;
  description?:
    | /**
     * Textual description of the project automation
     */
    /**
     * Textual description of the project automation
     */
    (| string
        /**
         * Textual description of the project automation
         */
        | null
      )
    | undefined;
  /**
   * The configuration for the org automation rule
   */
  config: {
    /**
     * The type of automation.
     *
     * @enum retention
     */
    event_type: "retention";
    object_type: RetentionObjectTypeType;
    /**
     * The number of days to retain the object
     *
     * @minimum 0
     */
    retention_days: number;
  };
};
export type ProjectSettingsType = Partial<{
  /**
   * The key used to join two experiments (defaults to `input`)
   */
  comparison_key: /**
     * The key used to join two experiments (defaults to `input`)
     */
    | string
    /**
     * The key used to join two experiments (defaults to `input`)
     */
    | null;
  /**
   * The id of the experiment to use as the default baseline for comparisons
   */
  baseline_experiment_id: /**
     * The id of the experiment to use as the default baseline for comparisons
     */
    | string
    /**
     * The id of the experiment to use as the default baseline for comparisons
     */
    | null;
  /**
   * The order of the fields to display in the trace view
   */
  spanFieldOrder: /**
     * The order of the fields to display in the trace view
     */
    | Array<{
        object_type: string;
        column_id: string;
        position: string;
        layout?:
          | (
              | /**
               * @enum full
               */
              "full"
              /**
               * @enum two_column
               */
              | "two_column"
              | null
            )
          | undefined;
      }>
    /**
     * The order of the fields to display in the trace view
     */
    | null;
  /**
   * The remote eval sources to use for the project
   */
  remote_eval_sources: /**
     * The remote eval sources to use for the project
     */
    | Array<{
        url: string;
        name?: (string | null) | undefined;
        description?: (string | null) | undefined;
      }>
    /**
     * The remote eval sources to use for the project
     */
    | null;
  /**
   * If true, disable real-time queries for this project. This can improve query performance for high-volume logs.
   */
  disable_realtime_queries: /**
     * If true, disable real-time queries for this project. This can improve query performance for high-volume logs.
     */
    | boolean
    /**
     * If true, disable real-time queries for this project. This can improve query performance for high-volume logs.
     */
    | null;
  /**
   * If true, use metrics.start rather than created for monitor chart time bucket dimensions.
   */
  monitor_charts_use_metrics_start: /**
     * If true, use metrics.start rather than created for monitor chart time bucket dimensions.
     */
    | boolean
    /**
     * If true, use metrics.start rather than created for monitor chart time bucket dimensions.
     */
    | null;
  default_preprocessor: NullableSavedFunctionIdType;
}> | null;
export type ProjectType = {
  /**
   * Unique identifier for the project
   */
  id: string;
  /**
   * Unique id for the organization that the project belongs under
   */
  org_id: string;
  /**
   * Name of the project
   */
  name: string;
  description?:
    | /**
     * Textual description of the project
     */
    /**
     * Textual description of the project
     */
    (| string
        /**
         * Textual description of the project
         */
        | null
      )
    | undefined;
  created?:
    | /**
     * Date of project creation
     */
    /**
     * Date of project creation
     */
    (| string
        /**
         * Date of project creation
         */
        | null
      )
    | undefined;
  deleted_at?:
    | /**
     * Date of project deletion, or null if the project is still active
     */
    /**
     * Date of project deletion, or null if the project is still active
     */
    (| string
        /**
         * Date of project deletion, or null if the project is still active
         */
        | null
      )
    | undefined;
  user_id?:
    | /**
     * Identifies the user who created the project
     */
    /**
     * Identifies the user who created the project
     */
    (| string
        /**
         * Identifies the user who created the project
         */
        | null
      )
    | undefined;
  settings?: ProjectSettingsType | undefined;
};
export type WindowedAutomationConfigType = {
  /**
   * The type of automation.
   *
   * @enum windowed
   */
  event_type: "windowed";
  product_origin?:
    | /**
     * The product surface that created and manages the automation
     *
     * @enum patterns
     */
    (| /**
         * The product surface that created and manages the automation
         *
         * @enum patterns
         */
        "patterns"
        /**
         * The product surface that created and manages the automation
         *
         * @enum patterns
         */
        | null
      )
    | undefined;
  status?: AutomationStatusType | undefined;
  threshold?: /**
     * Optional calculation and lifecycle policy that gate scheduled delivery
     */
    | {
        /**
         * The calculation evaluated for each window
         */
        calculation: {
          /**
           * @enum btql
           */
          type: "btql";
          /**
           * A project-scoped BTQL or SQL query without runtime-owned evaluation time bounds
           *
           * @minLength 1
           */
          btql_query: string;
          output: {
            /**
             * @enum scalar
             */
            type: "scalar";
            /**
             * The numeric result column produced by the query
             *
             * @minLength 1
             */
            value_column: string;
          };
        };
        /**
         * The lifecycle policy applied to each calculation result
         */
        policy: {
          condition: {
            /**
             * @enum threshold
             */
            type: "threshold";
            /**
             * @enum lt, lte, gt, gte, eq, neq
             */
            operator: "lt" | "lte" | "gt" | "gte" | "eq" | "neq";
            threshold: number;
          };
          /**
           * How long the condition must remain breached before firing
           *
           * @minimum 0
           * @maximum 2592000
           */
          pending_seconds: number;
          /**
           * How the lifecycle changes when the calculation returns no data
           *
           * @enum keep_last, resolve, alert
           */
          no_data_behavior: "keep_last" | "resolve" | "alert";
          renotify_interval_seconds?:
            | /**
             * Optional reminder interval while the automation is firing
             *
             * @minimum 1
             * @maximum 2592000
             */
            /**
             * Optional reminder interval while the automation is firing
             *
             * @minimum 1
             * @maximum 2592000
             */
            (| number
                /**
                 * Optional reminder interval while the automation is firing
                 *
                 * @minimum 1
                 * @maximum 2592000
                 */
                | null
              )
            | undefined;
          /**
           * Whether to deliver actions when a firing automation recovers
           *
           * @default true
           */
          notify_on_recovery: boolean;
        };
      }
    | undefined;
  window: {
    /**
     * How much recent data each scheduled run covers
     *
     * @minimum 1
     * @maximum 2592000
     */
    window_seconds: number;
    /**
     * How often the windowed automation runs: at a fixed interval or on a cron schedule
     */
    schedule:
      | {
          /**
           * @enum interval
           */
          type: "interval";
          /**
           * How often the automation runs
           *
           * @minimum 1
           * @maximum 2592000
           */
          evaluation_interval_seconds: number;
        }
      | {
          /**
           * @enum cron
           */
          type: "cron";
          /**
           * A standard five-field cron expression (minute hour day-of-month month day-of-week) controlling when the automation runs
           *
           * @minLength 1
           */
          cron_expression: string;
          timezone?:
            | /**
             * IANA timezone used to interpret the cron expression (defaults to UTC)
             *
             * @minLength 1
             */
            /**
             * IANA timezone used to interpret the cron expression (defaults to UTC)
             *
             * @minLength 1
             */
            (| string
                /**
                 * IANA timezone used to interpret the cron expression (defaults to UTC)
                 *
                 * @minLength 1
                 */
                | null
              )
            | undefined;
        };
    /**
     * How far behind the present each evaluation window ends
     *
     * @minimum 0
     * @maximum 2592000
     */
    evaluation_delay_seconds: number;
  };
  loop?: /**
     * Optional Loop agent to run for each triggered window
     */
    | {
        /**
         * Instructions for the Loop agent
         *
         * @minLength 1
         * @maxLength 10000
         */
        prompt: string;
        /**
         * Whether to include the automation trigger payload as input
         *
         * @default false
         */
        include_trigger_input: boolean;
        /**
         * The Loop agent to run
         *
         * @minLength 1
         */
        agent_slug: string;
        /**
         * Write tools that may run without interactive approval
         *
         * @default []
         */
        auto_approve_tools: Array</**
         * @minLength 1
         */
        string>;
        harness?:
          | /**
           * @enum native, codex, claude-code
           */
          ("native" | "codex" | "claude-code")
          | undefined;
        model?: /**
           * @minLength 1
           */
          string | undefined;
        reasoning_effort?:
          | /**
           * @enum none, minimal, low, medium, high, xhigh, max
           */
          ("none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max")
          | undefined;
      }
    | undefined;
  /**
   * Delivery actions exposed to Loop as tools, or run directly when Loop is not configured
   *
   * @default []
   */
  actions: Array<
    /**
     * A delivery action available to an automation
     */
    | {
        /**
         * The type of action to take
         *
         * @enum webhook
         */
        type: "webhook";
        /**
         * The webhook URL to send the request to
         */
        url: string;
        formatting_prompt?: /**
           * Instructions for Loop to format content sent to this destination
           *
           * @minLength 1
           * @maxLength 10000
           */
          string | undefined;
      }
    | {
        /**
         * The type of action to take
         *
         * @enum slack
         */
        type: "slack";
        /**
         * The Slack workspace ID to post to
         */
        workspace_id: string;
        /**
         * The Slack channel ID to post to
         */
        channel: string;
        message_template?: /**
           * Custom message template for the alert
           */
          string | undefined;
        formatting_prompt?: /**
           * Instructions for Loop to format content sent to this destination
           *
           * @minLength 1
           * @maxLength 10000
           */
          string | undefined;
      }
  >;
};
export type TopicAutomationFacetModelType =
  /**
   * Optional facet model override for topic automation
   *
   * @enum brain-facet-latest, brain-facet-1, brain-facet-2
   */
  | /**
   * Optional facet model override for topic automation
   *
   * @enum brain-facet-latest, brain-facet-1, brain-facet-2
   */
  ("brain-facet-latest" | "brain-facet-1" | "brain-facet-2")
  /**
   * Optional facet model override for topic automation
   *
   * @enum brain-facet-latest, brain-facet-1, brain-facet-2
   */
  | null;
export type TopicMapFunctionAutomationType = {
  function: SavedFunctionIdType &
    /**
     * Topic map function
     */ unknown;
  btql_filter?:
    | /**
     * Per-topic-map BTQL filter. For trace scope, a topic map runs when max(filter) over the trace is truthy. For span scope, it runs when the current span matches.
     */
    /**
     * Per-topic-map BTQL filter. For trace scope, a topic map runs when max(filter) over the trace is truthy. For span scope, it runs when the current span matches.
     */
    (| string
        /**
         * Per-topic-map BTQL filter. For trace scope, a topic map runs when max(filter) over the trace is truthy. For span scope, it runs when the current span matches.
         */
        | null
      )
    | undefined;
};
export type TopicAutomationDataScopeType =
  /**
   * Optional data scope for topic automation.
   */
  | {
      /**
       * @enum project_logs
       */
      type: "project_logs";
    }
  | {
      /**
       * @enum project_experiments
       */
      type: "project_experiments";
    }
  | {
      /**
       * @enum experiment
       */
      type: "experiment";
      experiment_id: string;
    }
  | null;
export type TopicAutomationConfigType = {
  /**
   * The type of automation.
   *
   * @enum topic
   */
  event_type: "topic";
  status?: AutomationStatusType | undefined;
  /**
   * The sampling rate for topic automation
   *
   * @minimum 0
   * @maximum 1
   */
  sampling_rate: number;
  facet_model?: TopicAutomationFacetModelType | undefined;
  /**
   * Facet functions used by the topic automation
   */
  facet_functions: Array<SavedFunctionIdType>;
  /**
   * Topic map functions with optional per-topic-map filters
   */
  topic_map_functions: Array<TopicMapFunctionAutomationType>;
  scope?:
    | /**
     * Execution scope for topic automation.
     */
    (SpanScopeType | TraceScopeType | GroupScopeType | null)
    | undefined;
  data_scope?: TopicAutomationDataScopeType | undefined;
  btql_filter?:
    | /**
     * Optional BTQL filter applied before topic automation.
     */
    /**
     * Optional BTQL filter applied before topic automation.
     */
    (| string
        /**
         * Optional BTQL filter applied before topic automation.
         */
        | null
      )
    | undefined;
  rerun_seconds?:
    | /**
     * How often to recompute topic maps
     *
     * @minimum 600
     */
    /**
     * How often to recompute topic maps
     *
     * @minimum 600
     */
    (| number
        /**
         * How often to recompute topic maps
         *
         * @minimum 600
         */
        | null
      )
    | undefined;
  relabel_overlap_seconds?:
    | /**
     * How much recent history to relabel after a new topic map version becomes active
     *
     * @minimum 60
     */
    /**
     * How much recent history to relabel after a new topic map version becomes active
     *
     * @minimum 60
     */
    (| number
        /**
         * How much recent history to relabel after a new topic map version becomes active
         *
         * @minimum 60
         */
        | null
      )
    | undefined;
  backfill_time_range?:
    | /**
     * Topic window used for classification coverage and initial backfill.
     */
    (| string
        | {
            from: string;
            to: string;
          }
        | null
      )
    | undefined;
};
export type TopicDigestAutomationConfigType = {
  /**
   * The type of automation.
   *
   * @enum topic_digest
   */
  event_type: "topic_digest";
  status?: AutomationStatusType | undefined;
  /**
   * How much recent history to include in each digest
   *
   * @default 86400
   * @minimum 3600
   * @maximum 2592000
   */
  window_seconds: number;
  /**
   * Minutes after midnight UTC when the digest should be sent
   *
   * @minimum 0
   * @maximum 1439
   */
  scheduled_time_minutes_utc: number;
  /**
   * The Slack action to take when the digest is sent
   */
  action: {
    /**
     * The type of action to take
     *
     * @enum slack
     */
    type: "slack";
    /**
     * The Slack workspace ID to post to
     */
    workspace_id: string;
    /**
     * The Slack channel ID to post to
     */
    channel: string;
    message_template?: /**
       * Custom message template for the alert
       */
      string | undefined;
    formatting_prompt?: /**
       * Instructions for Loop to format content sent to this destination
       *
       * @minLength 1
       * @maxLength 10000
       */
      string | undefined;
  };
  topic_map_function_ids?: /**
     * Optional topic map function IDs to include in the digest
     */
    Array<string> | undefined;
};
export type ProjectAutomationType = {
  /**
   * Unique identifier for the project automation
   */
  id: string;
  /**
   * Unique identifier for the project that the project automation belongs under
   */
  project_id: string;
  user_id?:
    | /**
     * Identifies the user who created the project automation
     */
    /**
     * Identifies the user who created the project automation
     */
    (| string
        /**
         * Identifies the user who created the project automation
         */
        | null
      )
    | undefined;
  created?:
    | /**
     * Date of project automation creation
     */
    /**
     * Date of project automation creation
     */
    (| string
        /**
         * Date of project automation creation
         */
        | null
      )
    | undefined;
  /**
   * Name of the project automation
   */
  name: string;
  description?:
    | /**
     * Textual description of the project automation
     */
    /**
     * Textual description of the project automation
     */
    (| string
        /**
         * Textual description of the project automation
         */
        | null
      )
    | undefined;
  /**
   * The configuration for the automation rule
   */
  config:
    | {
        /**
         * The type of automation.
         *
         * @enum logs
         */
        event_type: "logs";
        status?: AutomationStatusType | undefined;
        /**
         * BTQL filter to identify rows for the automation rule
         */
        btql_filter: string;
        /**
         * Perform the triggered action at most once in this interval of seconds
         *
         * @minimum 1
         * @maximum 2592000
         */
        interval_seconds: number;
        /**
         * The action to take when the automation rule is triggered
         */
        action:
          | {
              /**
               * The type of action to take
               *
               * @enum webhook
               */
              type: "webhook";
              /**
               * The webhook URL to send the request to
               */
              url: string;
              formatting_prompt?: /**
                 * Instructions for Loop to format content sent to this destination
                 *
                 * @minLength 1
                 * @maxLength 10000
                 */
                string | undefined;
            }
          | {
              /**
               * The type of action to take
               *
               * @enum slack
               */
              type: "slack";
              /**
               * The Slack workspace ID to post to
               */
              workspace_id: string;
              /**
               * The Slack channel ID to post to
               */
              channel: string;
              message_template?: /**
                 * Custom message template for the alert
                 */
                string | undefined;
              formatting_prompt?: /**
                 * Instructions for Loop to format content sent to this destination
                 *
                 * @minLength 1
                 * @maxLength 10000
                 */
                string | undefined;
            };
      }
    | {
        /**
         * The type of automation.
         *
         * @enum btql_export
         */
        event_type: "btql_export";
        status?: AutomationStatusType | undefined;
        /**
         * The definition of what to export
         */
        export_definition:
          | {
              /**
               * @enum log_traces
               */
              type: "log_traces";
            }
          | {
              /**
               * @enum log_spans
               */
              type: "log_spans";
            }
          | {
              /**
               * @enum btql_query
               */
              type: "btql_query";
              /**
               * The BTQL query to export
               */
              btql_query: string;
            };
        scope?:
          | /**
           * Execution scope for export automation. Defaults to span-level execution.
           */
          (SpanScopeType | TraceScopeType | GroupScopeType | null)
          | undefined;
        /**
         * The path to export the results to. It should include the storage protocol and prefix, e.g. s3://bucket-name/path/to/export
         */
        export_path: string;
        /**
         * The format to export the results in
         *
         * @enum jsonl, parquet
         */
        format: "jsonl" | "parquet";
        /**
         * Perform the triggered action at most once in this interval of seconds
         *
         * @minimum 1
         * @maximum 2592000
         */
        interval_seconds: number;
        credentials:
          | {
              /**
               * @enum aws_iam
               */
              type: "aws_iam";
              /**
               * The ARN of the IAM role to use
               */
              role_arn: string;
              /**
               * The automation-specific external id component (auto-generated by default)
               */
              external_id: string;
            }
          | {
              /**
               * @enum gcp_service_account
               */
              type: "gcp_service_account";
              /**
               * The GCP service account email to impersonate
               */
              service_account_email: string;
            };
        batch_size?:
          | /**
           * The number of rows to export in each batch
           */
          /**
           * The number of rows to export in each batch
           */
          (| number
              /**
               * The number of rows to export in each batch
               */
              | null
            )
          | undefined;
      }
    | {
        /**
         * The type of automation.
         *
         * @enum async_query
         */
        event_type: "async_query";
        status?: AutomationStatusType | undefined;
        /**
         * The user who submitted the async query
         */
        created_by_user_id: string;
        /**
         * The source object type for the async query
         *
         * @enum project_logs, experiment, dataset, playground_logs
         */
        object_type:
          | "project_logs"
          | "experiment"
          | "dataset"
          | "playground_logs";
        /**
         * The source object ID for the async query
         */
        object_id: string;
        /**
         * The SQL query to execute asynchronously
         */
        query: string;
        /**
         * The materialized result format
         *
         * @enum jsonl
         */
        format: "jsonl";
        batch_size?:
          | /**
           * The maximum number of result rows to write per async query batch
           *
           * @maximum 100000
           */
          /**
           * The maximum number of result rows to write per async query batch
           *
           * @maximum 100000
           */
          (| number
              /**
               * The maximum number of result rows to write per async query batch
               *
               * @maximum 100000
               */
              | null
            )
          | undefined;
      }
    | {
        /**
         * The type of automation.
         *
         * @enum retention
         */
        event_type: "retention";
        object_type: RetentionObjectTypeType;
        /**
         * The number of days to retain the object
         *
         * @minimum 0
         */
        retention_days: number;
      }
    | {
        /**
         * The type of automation.
         *
         * @enum environment_update
         */
        event_type: "environment_update";
        status?: AutomationStatusType | undefined;
        environment_filter?: /**
           * Optional list of environment slugs to filter by
           */
          Array<string> | undefined;
        /**
         * The action to take when the automation rule is triggered
         */
        action:
          | {
              /**
               * The type of action to take
               *
               * @enum webhook
               */
              type: "webhook";
              /**
               * The webhook URL to send the request to
               */
              url: string;
              formatting_prompt?: /**
                 * Instructions for Loop to format content sent to this destination
                 *
                 * @minLength 1
                 * @maxLength 10000
                 */
                string | undefined;
            }
          | {
              /**
               * The type of action to take
               *
               * @enum slack
               */
              type: "slack";
              /**
               * The Slack workspace ID to post to
               */
              workspace_id: string;
              /**
               * The Slack channel ID to post to
               */
              channel: string;
              message_template?: /**
                 * Custom message template for the alert
                 */
                string | undefined;
              formatting_prompt?: /**
                 * Instructions for Loop to format content sent to this destination
                 *
                 * @minLength 1
                 * @maxLength 10000
                 */
                string | undefined;
            };
      }
    | WindowedAutomationConfigType
    | TopicAutomationConfigType
    | TopicDigestAutomationConfigType;
};
export type ProjectGroupType = {
  /**
   * Unique identifier for the project group
   */
  id: string;
  /**
     * Unique id for the organization that the project group belongs under
    
    It is forbidden to change the org after creating a project group
     */
  org_id: string;
  user_id?:
    | /**
     * Identifies the user who created the project group
     */
    /**
     * Identifies the user who created the project group
     */
    (| string
        /**
         * Identifies the user who created the project group
         */
        | null
      )
    | undefined;
  created?:
    | /**
     * Date of project group creation
     */
    /**
     * Date of project group creation
     */
    (| string
        /**
         * Date of project group creation
         */
        | null
      )
    | undefined;
  /**
   * Name of the project group
   */
  name: string;
  description?:
    | /**
     * Textual description of the project group
     */
    /**
     * Textual description of the project group
     */
    (| string
        /**
         * Textual description of the project group
         */
        | null
      )
    | undefined;
  deleted_at?:
    | /**
     * Date of project group deletion, or null if the project group is still active
     */
    /**
     * Date of project group deletion, or null if the project group is still active
     */
    (| string
        /**
         * Date of project group deletion, or null if the project group is still active
         */
        | null
      )
    | undefined;
  /**
   * Sorted ids of active projects in this project group
   */
  member_projects: Array<string>;
};
export type ProjectLogsEventType = {
  /**
   * A unique identifier for the project logs event. If you don't provide one, Braintrust will generate one for you
   */
  id: string;
  /**
   * The transaction id of an event is unique to the network operation that processed the event insertion. Transaction ids are monotonically increasing over time and can be used to retrieve a versioned snapshot of the project logs (see the `version` parameter)
   */
  _xact_id: string;
  _pagination_key?:
    | /**
     * A stable, time-ordered key that can be used to paginate over project logs events. This field is auto-generated by Braintrust and only exists in Brainstore.
     */
    /**
     * A stable, time-ordered key that can be used to paginate over project logs events. This field is auto-generated by Braintrust and only exists in Brainstore.
     */
    (| string
        /**
         * A stable, time-ordered key that can be used to paginate over project logs events. This field is auto-generated by Braintrust and only exists in Brainstore.
         */
        | null
      )
    | undefined;
  /**
   * The timestamp the project logs event was created
   */
  created: string;
  /**
   * Unique id for the organization that the project belongs under
   */
  org_id: string;
  /**
   * Unique identifier for the project
   */
  project_id: string;
  /**
   * A literal 'g' which identifies the log as a project log
   *
   * @enum g
   */
  log_id: "g";
  input?: /**
     * The arguments that uniquely define a user input (an arbitrary, JSON serializable object).
     */
    unknown | undefined;
  output?: /**
     * The output of your application, including post-processing (an arbitrary, JSON serializable object), that allows you to determine whether the result is correct or not. For example, in an app that generates SQL queries, the `output` should be the _result_ of the SQL query generated by the model, not the query itself, because there may be multiple valid queries that answer a single question.
     */
    unknown | undefined;
  expected?: /**
     * The ground truth value (an arbitrary, JSON serializable object) that you'd compare to `output` to determine if your `output` value is correct or not. Braintrust currently does not compare `output` to `expected` for you, since there are so many different ways to do that correctly. Instead, these values are just used to help you navigate while digging into analyses. However, we may later use these values to re-score outputs or fine-tune your models.
     */
    unknown | undefined;
  error?: /**
     * The error that occurred, if any.
     */
    unknown | undefined;
  scores?:
    | /**
     * A dictionary of numeric values (between 0 and 1) to log. The scores should give you a variety of signals that help you determine how accurate the outputs are compared to what you expect and diagnose failures. For example, a summarization app might have one score that tells you how accurate the summary is, and another that measures the word similarity between the generated and grouth truth summary. The word similarity score could help you determine whether the summarization was covering similar concepts or not. You can use these scores to help you sort, filter, and compare logs.
     */
    /**
     * A dictionary of numeric values (between 0 and 1) to log. The scores should give you a variety of signals that help you determine how accurate the outputs are compared to what you expect and diagnose failures. For example, a summarization app might have one score that tells you how accurate the summary is, and another that measures the word similarity between the generated and grouth truth summary. The word similarity score could help you determine whether the summarization was covering similar concepts or not. You can use these scores to help you sort, filter, and compare logs.
     */
    (| {}
        /**
         * A dictionary of numeric values (between 0 and 1) to log. The scores should give you a variety of signals that help you determine how accurate the outputs are compared to what you expect and diagnose failures. For example, a summarization app might have one score that tells you how accurate the summary is, and another that measures the word similarity between the generated and grouth truth summary. The word similarity score could help you determine whether the summarization was covering similar concepts or not. You can use these scores to help you sort, filter, and compare logs.
         */
        | null
      )
    | undefined;
  metadata?:
    | /**
     * A dictionary with additional data about the test example, model outputs, or just about anything else that's relevant, that you can use to help find and analyze examples later. For example, you could log the `prompt`, example's `id`, or anything else that would be useful to slice/dice later. The values in `metadata` can be any JSON-serializable type, but its keys must be strings
     */
    /**
     * A dictionary with additional data about the test example, model outputs, or just about anything else that's relevant, that you can use to help find and analyze examples later. For example, you could log the `prompt`, example's `id`, or anything else that would be useful to slice/dice later. The values in `metadata` can be any JSON-serializable type, but its keys must be strings
     */
    (| Partial<
            {
              /**
               * The model used for this example
               */
              model: /**
                 * The model used for this example
                 */
                | string
                /**
                 * The model used for this example
                 */
                | null;
            } & {
              [key: string]: any;
            }
          >
        /**
         * A dictionary with additional data about the test example, model outputs, or just about anything else that's relevant, that you can use to help find and analyze examples later. For example, you could log the `prompt`, example's `id`, or anything else that would be useful to slice/dice later. The values in `metadata` can be any JSON-serializable type, but its keys must be strings
         */
        | null
      )
    | undefined;
  tags?:
    | /**
     * A list of tags to log
     */
    /**
     * A list of tags to log
     */
    (| Array<string>
        /**
         * A list of tags to log
         */
        | null
      )
    | undefined;
  metrics?:
    | /**
     * Metrics are numerical measurements tracking the execution of the code that produced the project logs event. Use "start" and "end" to track the time span over which the project logs event was produced
     */
    (| /**
         * Metrics are numerical measurements tracking the execution of the code that produced the project logs event. Use "start" and "end" to track the time span over which the project logs event was produced
         */
        ({} & {
            [key: string]: number;
          })
        /**
         * Metrics are numerical measurements tracking the execution of the code that produced the project logs event. Use "start" and "end" to track the time span over which the project logs event was produced
         */
        | null
      )
    | undefined;
  context?:
    | /**
     * Context is additional information about the code that produced the project logs event. It is essentially the textual counterpart to `metrics`. Use the `caller_*` attributes to track the location in code which produced the project logs event
     */
    /**
     * Context is additional information about the code that produced the project logs event. It is essentially the textual counterpart to `metrics`. Use the `caller_*` attributes to track the location in code which produced the project logs event
     */
    (| Partial<
            {
              /**
               * The function in code which created the project logs event
               */
              caller_functionname: /**
                 * The function in code which created the project logs event
                 */
                | string
                /**
                 * The function in code which created the project logs event
                 */
                | null;
              /**
               * Name of the file in code where the project logs event was created
               */
              caller_filename: /**
                 * Name of the file in code where the project logs event was created
                 */
                | string
                /**
                 * Name of the file in code where the project logs event was created
                 */
                | null;
              /**
               * Line of code where the project logs event was created
               */
              caller_lineno: /**
                 * Line of code where the project logs event was created
                 */
                | number
                /**
                 * Line of code where the project logs event was created
                 */
                | null;
            } & {
              [key: string]: any;
            }
          >
        /**
         * Context is additional information about the code that produced the project logs event. It is essentially the textual counterpart to `metrics`. Use the `caller_*` attributes to track the location in code which produced the project logs event
         */
        | null
      )
    | undefined;
  /**
   * A unique identifier used to link different project logs events together as part of a full trace. See the [tracing guide](https://www.braintrust.dev/docs/instrument) for full details on tracing
   */
  span_id: string;
  span_parents?:
    | /**
     * An array of the parent `span_ids` of this project logs event. This should be empty for the root span of a trace, and should most often contain just one parent element for subspans
     */
    /**
     * An array of the parent `span_ids` of this project logs event. This should be empty for the root span of a trace, and should most often contain just one parent element for subspans
     */
    (| Array<string>
        /**
         * An array of the parent `span_ids` of this project logs event. This should be empty for the root span of a trace, and should most often contain just one parent element for subspans
         */
        | null
      )
    | undefined;
  /**
   * A unique identifier for the trace this project logs event belongs to
   */
  root_span_id: string;
  is_root?:
    | /**
     * Whether this span is a root span
     */
    /**
     * Whether this span is a root span
     */
    (| boolean
        /**
         * Whether this span is a root span
         */
        | null
      )
    | undefined;
  span_attributes?: SpanAttributesType | undefined;
  origin?: ObjectReferenceNullishType | undefined;
  comments?:
    | /**
     * Optional list of comments attached to this event
     */
    /**
     * Optional list of comments attached to this event
     */
    (| Array<unknown>
        /**
         * Optional list of comments attached to this event
         */
        | null
      )
    | undefined;
  audit_data?:
    | /**
     * Optional list of audit entries attached to this event
     */
    /**
     * Optional list of audit entries attached to this event
     */
    (| Array<unknown>
        /**
         * Optional list of audit entries attached to this event
         */
        | null
      )
    | undefined;
  _async_scoring_state?: /**
     * The async scoring state for this event
     */
    unknown | undefined;
  facets?:
    | /**
     * Facets for categorization (dictionary from facet id to value)
     */
    /**
     * Facets for categorization (dictionary from facet id to value)
     */
    (| {}
        /**
         * Facets for categorization (dictionary from facet id to value)
         */
        | null
      )
    | undefined;
  classifications?:
    | /**
     * Classifications for this event (dictionary from classification name to items)
     */
    /**
     * Classifications for this event (dictionary from classification name to items)
     */
    (| {}
        /**
         * Classifications for this event (dictionary from classification name to items)
         */
        | null
      )
    | undefined;
};
export type ProjectScoreTypeType =
  /**
   * The type of the configured score
   *
   * @enum slider, categorical, weighted, minimum, maximum, online, free-form
   */
  | "slider"
  | "categorical"
  | "weighted"
  | "minimum"
  | "maximum"
  | "online"
  | "free-form";
export type ProjectScoreCategoryType = {
  /**
   * Name of the category
   */
  name: string;
  /**
   * Numerical value of the category. Must be between 0 and 1, inclusive
   */
  value: number;
};
export type ProjectScoreCategoriesType =
  /**
   * For categorical-type project scores, the list of all categories
   */
  | Array<ProjectScoreCategoryType>
  /**
   * For weighted-type project scores, the weights of each score
   */
  | {}
  /**
   * For minimum-type project scores, the list of included scores
   */
  | Array<string>
  | null;
export type ProjectScoreConditionType = {
  when: Partial<{
    clauses: Array<string> | null;
    subspan_clauses: Array<string> | null;
    trace_clauses: Array<string> | null;
  }>;
  /**
   * @default "hidden"
   * @enum hidden
   */
  behavior: "hidden";
} | null;
export type ProjectScoreConfigType = Partial<{
  multi_select: boolean | null;
  destination: string | null;
  visibility: Partial<{
    users: Array<string> | null;
    groups: Array<string> | null;
  }> | null;
  online: OnlineScoreConfigType;
  condition: ProjectScoreConditionType;
  object_types: Array<
    /**
     * @enum project_logs, dataset, experiment
     */
    "project_logs" | "dataset" | "experiment"
  > | null;
}> | null;
export type ProjectScoreType = {
  /**
   * Unique identifier for the project score
   */
  id: string;
  /**
   * Unique identifier for the project that the project score belongs under
   */
  project_id: string;
  user_id: string;
  created?:
    | /**
     * Date of project score creation
     */
    /**
     * Date of project score creation
     */
    (| string
        /**
         * Date of project score creation
         */
        | null
      )
    | undefined;
  /**
   * Name of the project score
   */
  name: string;
  description?:
    | /**
     * Textual description of the project score
     */
    /**
     * Textual description of the project score
     */
    (| string
        /**
         * Textual description of the project score
         */
        | null
      )
    | undefined;
  score_type: ProjectScoreTypeType;
  categories?: ProjectScoreCategoriesType | undefined;
  config?: ProjectScoreConfigType | undefined;
  position?:
    | /**
     * An optional LexoRank-based string that sets the sort position for the score in the UI
     */
    /**
     * An optional LexoRank-based string that sets the sort position for the score in the UI
     */
    (| string
        /**
         * An optional LexoRank-based string that sets the sort position for the score in the UI
         */
        | null
      )
    | undefined;
};
export type ProjectTagType = {
  /**
   * Unique identifier for the project tag
   */
  id: string;
  /**
   * Unique identifier for the project that the project tag belongs under
   */
  project_id: string;
  user_id: string;
  created?:
    | /**
     * Date of project tag creation
     */
    /**
     * Date of project tag creation
     */
    (| string
        /**
         * Date of project tag creation
         */
        | null
      )
    | undefined;
  /**
   * Name of the project tag
   */
  name: string;
  description?:
    | /**
     * Textual description of the project tag
     */
    /**
     * Textual description of the project tag
     */
    (| string
        /**
         * Textual description of the project tag
         */
        | null
      )
    | undefined;
  color?:
    | /**
     * Color of the tag for the UI
     */
    /**
     * Color of the tag for the UI
     */
    (| string
        /**
         * Color of the tag for the UI
         */
        | null
      )
    | undefined;
  position?:
    | /**
     * An optional LexoRank-based string that sets the sort position for the tag in the UI
     */
    /**
     * An optional LexoRank-based string that sets the sort position for the tag in the UI
     */
    (| string
        /**
         * An optional LexoRank-based string that sets the sort position for the tag in the UI
         */
        | null
      )
    | undefined;
};
export type PromptType = {
  /**
   * Unique identifier for the prompt
   */
  id: string;
  /**
   * The transaction id of an event is unique to the network operation that processed the event insertion. Transaction ids are monotonically increasing over time and can be used to retrieve a versioned snapshot of the prompt (see the `version` parameter)
   */
  _xact_id: string;
  /**
   * Unique identifier for the project that the prompt belongs under
   */
  project_id: string;
  /**
   * A literal 'p' which identifies the object as a project prompt
   *
   * @enum p
   */
  log_id: "p";
  /**
   * Unique identifier for the organization
   */
  org_id: string;
  /**
   * Name of the prompt
   */
  name: string;
  /**
   * Unique identifier for the prompt
   */
  slug: string;
  description?:
    | /**
     * Textual description of the prompt
     */
    /**
     * Textual description of the prompt
     */
    (| string
        /**
         * Textual description of the prompt
         */
        | null
      )
    | undefined;
  created?:
    | /**
     * Date of prompt creation
     */
    /**
     * Date of prompt creation
     */
    (| string
        /**
         * Date of prompt creation
         */
        | null
      )
    | undefined;
  prompt_data?: PromptDataNullishType | undefined;
  tags?:
    | /**
     * A list of tags for the prompt
     */
    /**
     * A list of tags for the prompt
     */
    (| Array<string>
        /**
         * A list of tags for the prompt
         */
        | null
      )
    | undefined;
  metadata?:
    | /**
     * User-controlled metadata about the prompt
     */
    /**
     * User-controlled metadata about the prompt
     */
    (| {}
        /**
         * User-controlled metadata about the prompt
         */
        | null
      )
    | undefined;
  function_type?: FunctionTypeEnumNullishType | undefined;
};
export type PromptOptionsType = Partial<{
  model: string;
  params: ModelParamsType;
  position: string;
  endpoint_name: string | null;
}>;
export type PromptSessionEventType = {
  /**
   * A unique identifier for the prompt session event. If you don't provide one, Braintrust will generate one for you
   */
  id: string;
  /**
   * The transaction id of an event is unique to the network operation that processed the event insertion. Transaction ids are monotonically increasing over time and can be used to retrieve a versioned snapshot of the prompt session (see the `version` parameter)
   */
  _xact_id: string;
  /**
   * The timestamp the prompt session event was created
   */
  created: string;
  _pagination_key?:
    | /**
     * A stable, time-ordered key that can be used to paginate over prompt session events. This field is auto-generated by Braintrust and only exists in Brainstore.
     */
    /**
     * A stable, time-ordered key that can be used to paginate over prompt session events. This field is auto-generated by Braintrust and only exists in Brainstore.
     */
    (| string
        /**
         * A stable, time-ordered key that can be used to paginate over prompt session events. This field is auto-generated by Braintrust and only exists in Brainstore.
         */
        | null
      )
    | undefined;
  /**
   * Unique identifier for the project that the prompt belongs under
   */
  project_id: string;
  /**
   * Unique identifier for the prompt
   */
  prompt_session_id: string;
  prompt_session_data?: /**
     * Data about the prompt session
     */
    unknown | undefined;
  prompt_data?: /**
     * Data about the prompt
     */
    unknown | undefined;
  function_data?: /**
     * Data about the function
     */
    unknown | undefined;
  function_type?: FunctionTypeEnumNullishType | undefined;
  object_data?: /**
     * Data about the mapped data
     */
    unknown | undefined;
  completion?: /**
     * Data about the completion
     */
    unknown | undefined;
  tags?:
    | /**
     * A list of tags to log
     */
    /**
     * A list of tags to log
     */
    (| Array<string>
        /**
         * A list of tags to log
         */
        | null
      )
    | undefined;
};
export type ResponseFormatType =
  | {
      /**
       * @enum json_object
       */
      type: "json_object";
    }
  | {
      /**
       * @enum json_schema
       */
      type: "json_schema";
      json_schema: ResponseFormatJsonSchemaType;
    }
  | {
      /**
       * @enum text
       */
      type: "text";
    };
export type RoleType = {
  /**
   * Unique identifier for the role
   */
  id: string;
  org_id?:
    | /**
     * Unique id for the organization that the role belongs under
    
    A null org_id indicates a system role, which may be assigned to anybody and inherited by any other role, but cannot be edited.
    
    It is forbidden to change the org after creating a role
     */
    /**
     * Unique id for the organization that the role belongs under
    
    A null org_id indicates a system role, which may be assigned to anybody and inherited by any other role, but cannot be edited.
    
    It is forbidden to change the org after creating a role
     */
    (| string /**
     * Unique id for the organization that the role belongs under
    
    A null org_id indicates a system role, which may be assigned to anybody and inherited by any other role, but cannot be edited.
    
    It is forbidden to change the org after creating a role
     */
        | null
      )
    | undefined;
  user_id?:
    | /**
     * Identifies the user who created the role
     */
    /**
     * Identifies the user who created the role
     */
    (| string
        /**
         * Identifies the user who created the role
         */
        | null
      )
    | undefined;
  created?:
    | /**
     * Date of role creation
     */
    /**
     * Date of role creation
     */
    (| string
        /**
         * Date of role creation
         */
        | null
      )
    | undefined;
  /**
   * Name of the role
   */
  name: string;
  description?:
    | /**
     * Textual description of the role
     */
    /**
     * Textual description of the role
     */
    (| string
        /**
         * Textual description of the role
         */
        | null
      )
    | undefined;
  deleted_at?:
    | /**
     * Date of role deletion, or null if the role is still active
     */
    /**
     * Date of role deletion, or null if the role is still active
     */
    (| string
        /**
         * Date of role deletion, or null if the role is still active
         */
        | null
      )
    | undefined;
  member_permissions?:
    | /**
     * (permission, restrict_object_type) tuples which belong to this role
     */
    /**
     * (permission, restrict_object_type) tuples which belong to this role
     */
    (| Array<{
            permission: PermissionType;
            restrict_object_type?: AclObjectTypeType | undefined;
          }>
        /**
         * (permission, restrict_object_type) tuples which belong to this role
         */
        | null
      )
    | undefined;
  member_roles?:
    | /**
     * Ids of the roles this role inherits from
    
    An inheriting role has all the permissions contained in its member roles, as well as all of their inherited permissions
     */
    /**
     * Ids of the roles this role inherits from
    
    An inheriting role has all the permissions contained in its member roles, as well as all of their inherited permissions
     */
    (| Array<string> /**
     * Ids of the roles this role inherits from
    
    An inheriting role has all the permissions contained in its member roles, as well as all of their inherited permissions
     */
        | null
      )
    | undefined;
};
export type RunEvalType = {
  /**
   * Unique identifier for the project to run the eval in
   */
  project_id: string;
  /**
   * The dataset to use
   */
  data: /**
     * Dataset id
     */
    | {
        dataset_id: string;
        dataset_version?:
          | /**
           * The version of the dataset to evaluate
           */
          /**
           * The version of the dataset to evaluate
           */
          (| string
              /**
               * The version of the dataset to evaluate
               */
              | null
            )
          | undefined;
        dataset_environment?:
          | /**
           * The environment tag that resolves to the dataset version to evaluate
           */
          /**
           * The environment tag that resolves to the dataset version to evaluate
           */
          (| string
              /**
               * The environment tag that resolves to the dataset version to evaluate
               */
              | null
            )
          | undefined;
        _internal_btql?: ({} | null) | undefined;
      }
    /**
     * Project and dataset name
     */
    | {
        project_name: string;
        dataset_name: string;
        dataset_version?:
          | /**
           * The version of the dataset to evaluate
           */
          /**
           * The version of the dataset to evaluate
           */
          (| string
              /**
               * The version of the dataset to evaluate
               */
              | null
            )
          | undefined;
        dataset_environment?:
          | /**
           * The environment tag that resolves to the dataset version to evaluate
           */
          /**
           * The environment tag that resolves to the dataset version to evaluate
           */
          (| string
              /**
               * The environment tag that resolves to the dataset version to evaluate
               */
              | null
            )
          | undefined;
        _internal_btql?: ({} | null) | undefined;
      }
    /**
     * Dataset rows
     */
    | {
        data: Array<unknown>;
      }
    /**
     * Experiment whose inputs and outputs should be used as dataset inputs and expected values
     */
    | {
        experiment_name: string;
      };
  name?: /**
     * The name of the eval to run when multiple evals available
     */
    string | undefined;
  parameters?: /**
     * Values for any parameters used in the eval
     */
    {} | undefined;
  task: FunctionIdType &
    /**
     * The function to evaluate
     */ unknown;
  /**
   * The functions to score the eval on
   */
  scores: Array<FunctionIdType>;
  experiment_name?: /**
     * An optional name for the experiment created by this eval. If it conflicts with an existing experiment, it will be suffixed with a unique identifier.
     */
    string | undefined;
  metadata?: /**
     * Optional experiment-level metadata to store about the evaluation. You can later use this to slice & dice across experiments.
     */
    {} | undefined;
  parent?:
    | (InvokeParentType &
        /**
         * Options for tracing the evaluation
         */ unknown)
    | undefined;
  stream?: /**
     * Whether to stream the results of the eval. If true, the request will return two events: one to indicate the experiment has started, and another upon completion. If false, the request will return the evaluation's summary upon completion.
     */
    boolean | undefined;
  trial_count?:
    | /**
     * The number of times to run the evaluator per input. This is useful for evaluating applications that have non-deterministic behavior and gives you both a stronger aggregate measure and a sense of the variance in the results.
     */
    /**
     * The number of times to run the evaluator per input. This is useful for evaluating applications that have non-deterministic behavior and gives you both a stronger aggregate measure and a sense of the variance in the results.
     */
    (| number
        /**
         * The number of times to run the evaluator per input. This is useful for evaluating applications that have non-deterministic behavior and gives you both a stronger aggregate measure and a sense of the variance in the results.
         */
        | null
      )
    | undefined;
  is_public?:
    | /**
     * Whether the experiment should be public. Defaults to false.
     */
    /**
     * Whether the experiment should be public. Defaults to false.
     */
    (| boolean
        /**
         * Whether the experiment should be public. Defaults to false.
         */
        | null
      )
    | undefined;
  timeout?:
    | /**
     * The maximum duration, in milliseconds, to run the evaluation. Defaults to undefined, in which case there is no timeout.
     */
    /**
     * The maximum duration, in milliseconds, to run the evaluation. Defaults to undefined, in which case there is no timeout.
     */
    (| number
        /**
         * The maximum duration, in milliseconds, to run the evaluation. Defaults to undefined, in which case there is no timeout.
         */
        | null
      )
    | undefined;
  /**
   * The maximum number of tasks/scorers that will be run concurrently. Defaults to 10. If null is provided, no max concurrency will be used.
   *
   * @default 10
   */
  max_concurrency: /**
     * The maximum number of tasks/scorers that will be run concurrently. Defaults to 10. If null is provided, no max concurrency will be used.
     *
     * @default 10
     */
    | number
    /**
     * The maximum number of tasks/scorers that will be run concurrently. Defaults to 10. If null is provided, no max concurrency will be used.
     *
     * @default 10
     */
    | null;
  base_experiment_name?:
    | /**
     * An optional experiment name to use as a base. If specified, the new experiment will be summarized and compared to this experiment.
     */
    /**
     * An optional experiment name to use as a base. If specified, the new experiment will be summarized and compared to this experiment.
     */
    (| string
        /**
         * An optional experiment name to use as a base. If specified, the new experiment will be summarized and compared to this experiment.
         */
        | null
      )
    | undefined;
  base_experiment_id?:
    | /**
     * An optional experiment id to use as a base. If specified, the new experiment will be summarized and compared to this experiment.
     */
    /**
     * An optional experiment id to use as a base. If specified, the new experiment will be summarized and compared to this experiment.
     */
    (| string
        /**
         * An optional experiment id to use as a base. If specified, the new experiment will be summarized and compared to this experiment.
         */
        | null
      )
    | undefined;
  git_metadata_settings?:
    | (GitMetadataSettingsType &
        /**
         * Optional settings for collecting git metadata. By default, will collect git metadata fields allowed in org-level settings, excluding diff content unless the org opts in.
         */ /**
         * Optional settings for collecting git metadata. By default, will collect git metadata fields allowed in org-level settings, excluding diff content unless the org opts in.
         */
        (| {}
          /**
           * Optional settings for collecting git metadata. By default, will collect git metadata fields allowed in org-level settings, excluding diff content unless the org opts in.
           */
          | null
        ))
    | undefined;
  repo_info?:
    | (RepoInfoType &
        /**
         * Optionally explicitly specify the git metadata for this experiment. This takes precedence over `gitMetadataSettings` if specified.
         */ unknown)
    | undefined;
  strict?:
    | /**
     * If true, throw an error if one of the variables in the prompt is not present in the input
     */
    /**
     * If true, throw an error if one of the variables in the prompt is not present in the input
     */
    (| boolean
        /**
         * If true, throw an error if one of the variables in the prompt is not present in the input
         */
        | null
      )
    | undefined;
  stop_token?:
    | /**
     * The token to stop the run
     */
    /**
     * The token to stop the run
     */
    (| string
        /**
         * The token to stop the run
         */
        | null
      )
    | undefined;
  extra_messages?: /**
     * A template path of extra messages to append to the conversion. These messages will be appended to the end of the conversation, after the last message.
     */
    string | undefined;
  tags?: /**
     * Optional tags that will be added to the experiment.
     */
    Array<string> | undefined;
  mcp_auth?: {} | undefined;
  endpoint_name?:
    | /**
     * Name of the AI provider secret to pin this run to.
     */
    /**
     * Name of the AI provider secret to pin this run to.
     */
    (| string
        /**
         * Name of the AI provider secret to pin this run to.
         */
        | null
      )
    | undefined;
};
export type ServiceTokenType = {
  /**
   * Unique identifier for the service token
   */
  id: string;
  created?:
    | /**
     * Date of service token creation
     */
    /**
     * Date of service token creation
     */
    (| string
        /**
         * Date of service token creation
         */
        | null
      )
    | undefined;
  /**
   * Name of the service token
   */
  name: string;
  preview_name: string;
  service_account_id?:
    | /**
     * Unique identifier for the service token
     */
    /**
     * Unique identifier for the service token
     */
    (| string
        /**
         * Unique identifier for the service token
         */
        | null
      )
    | undefined;
  service_account_email?:
    | /**
     * The service account email (not routable)
     */
    /**
     * The service account email (not routable)
     */
    (| string
        /**
         * The service account email (not routable)
         */
        | null
      )
    | undefined;
  service_account_name?:
    | /**
     * The service account name
     */
    /**
     * The service account name
     */
    (| string
        /**
         * The service account name
         */
        | null
      )
    | undefined;
  org_id?:
    | /**
     * Unique identifier for the organization
     */
    /**
     * Unique identifier for the organization
     */
    (| string
        /**
         * Unique identifier for the organization
         */
        | null
      )
    | undefined;
  expires_at?:
    | /**
     * Date and time at which the service token expires. If null, the token never expires.
     */
    /**
     * Date and time at which the service token expires. If null, the token never expires.
     */
    (| string
        /**
         * Date and time at which the service token expires. If null, the token never expires.
         */
        | null
      )
    | undefined;
};
export type SpanIFrameType = {
  /**
   * Unique identifier for the span iframe
   */
  id: string;
  /**
   * Unique identifier for the project that the span iframe belongs under
   */
  project_id: string;
  user_id?:
    | /**
     * Identifies the user who created the span iframe
     */
    /**
     * Identifies the user who created the span iframe
     */
    (| string
        /**
         * Identifies the user who created the span iframe
         */
        | null
      )
    | undefined;
  created?:
    | /**
     * Date of span iframe creation
     */
    /**
     * Date of span iframe creation
     */
    (| string
        /**
         * Date of span iframe creation
         */
        | null
      )
    | undefined;
  deleted_at?:
    | /**
     * Date of span iframe deletion, or null if the span iframe is still active
     */
    /**
     * Date of span iframe deletion, or null if the span iframe is still active
     */
    (| string
        /**
         * Date of span iframe deletion, or null if the span iframe is still active
         */
        | null
      )
    | undefined;
  /**
   * Name of the span iframe
   */
  name: string;
  description?:
    | /**
     * Textual description of the span iframe
     */
    /**
     * Textual description of the span iframe
     */
    (| string
        /**
         * Textual description of the span iframe
         */
        | null
      )
    | undefined;
  /**
   * URL to embed the project viewer in an iframe
   */
  url: string;
  post_message?:
    | /**
     * Whether to post messages to the iframe containing the span's data. This is useful when you want to render more data than fits in the URL.
     */
    /**
     * Whether to post messages to the iframe containing the span's data. This is useful when you want to render more data than fits in the URL.
     */
    (| boolean
        /**
         * Whether to post messages to the iframe containing the span's data. This is useful when you want to render more data than fits in the URL.
         */
        | null
      )
    | undefined;
};
export type SSEConsoleEventDataType = {
  /**
   * @enum stderr, stdout
   */
  stream: "stderr" | "stdout";
  message: string;
};
export type SSEProgressEventDataType = {
  /**
   * The id of the span this event is for
   */
  id: string;
  object_type: FunctionObjectTypeType;
  origin?:
    | (ObjectReferenceNullishType &
        /**
         * The origin of the event
         */ unknown)
    | undefined;
  format: FunctionFormatType;
  output_type: FunctionOutputTypeType;
  name: string;
  /**
   * @enum reasoning_delta, text_delta, json_delta, error, console, start, done, progress
   */
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
};
export type ToolFunctionDefinitionType = {
  /**
   * @enum function
   */
  type: "function";
  function: {
    name: string;
    description?: string | undefined;
    parameters?: {} | undefined;
    strict?: (boolean | null) | undefined;
  };
};
export type UserType = {
  /**
   * Unique identifier for the user
   */
  id: string;
  given_name?:
    | /**
     * Given name of the user
     */
    /**
     * Given name of the user
     */
    (| string
        /**
         * Given name of the user
         */
        | null
      )
    | undefined;
  family_name?:
    | /**
     * Family name of the user
     */
    /**
     * Family name of the user
     */
    (| string
        /**
         * Family name of the user
         */
        | null
      )
    | undefined;
  email?:
    | /**
     * The user's email
     */
    /**
     * The user's email
     */
    (| string
        /**
         * The user's email
         */
        | null
      )
    | undefined;
  avatar_url?:
    | /**
     * URL of the user's Avatar image
     */
    /**
     * URL of the user's Avatar image
     */
    (| string
        /**
         * URL of the user's Avatar image
         */
        | null
      )
    | undefined;
  created?:
    | /**
     * Date of user creation
     */
    /**
     * Date of user creation
     */
    (| string
        /**
         * Date of user creation
         */
        | null
      )
    | undefined;
};
export type ViewDataSearchType = Partial<{
  filter: Array<unknown> | null;
  tag: Array<unknown> | null;
  match: Array<unknown> | null;
  sort: Array<unknown> | null;
}> | null;
export type ViewDataType =
  /**
   * The view definition
   */
  /**
   * The view definition
   */
  | Partial<{
      search: ViewDataSearchType;
      custom_charts: unknown;
    }>
  /**
   * The view definition
   */
  | null;
export type ViewOptionsType =
  /**
   * Options for the view in the app
   */
  | {
      /**
       * @enum monitor
       */
      viewType: "monitor";
      options: Partial<{
        /**
         * @enum range, frame
         */
        spanType:
          | /**
           * @enum range, frame
           */
          ("range" | "frame")
          /**
           * @enum range, frame
           */
          | null;
        rangeValue: string | null;
        frameStart: string | null;
        frameEnd: string | null;
        tzUTC: boolean | null;
        chartVisibility: {} | null;
        projectId: string | null;
        /**
         * @enum project, experiment
         */
        type:
          | /**
           * @enum project, experiment
           */
          ("project" | "experiment")
          /**
           * @enum project, experiment
           */
          | null;
        groupBy: string | null;
      }>;
      freezeColumns?: (boolean | null) | undefined;
    }
  | Partial<{
      columnVisibility: {} | null;
      columnOrder: Array<string> | null;
      columnSizing: {} | null;
      grouping: string | null;
      rowHeight: string | null;
      tallGroupRows: boolean | null;
      layout: string | null;
      topicMapReportKey: string | null;
      chartHeight: number | null;
      excludedMeasures: Array<{
        /**
         * @enum none, score, metric, metadata
         */
        type: "none" | "score" | "metric" | "metadata";
        value: string;
      }> | null;
      yMetric: {
        /**
         * @enum none, score, metric, metadata
         */
        type: "none" | "score" | "metric" | "metadata";
        value: string;
      } | null;
      xAxis: {
        /**
         * @enum none, score, metric, metadata
         */
        type: "none" | "score" | "metric" | "metadata";
        value: string;
      } | null;
      symbolGrouping: {
        /**
         * @enum none, score, metric, metadata
         */
        type: "none" | "score" | "metric" | "metadata";
        value: string;
      } | null;
      pointSizeMetric: {
        /**
         * @enum none, score, metric, metadata
         */
        type: "none" | "score" | "metric" | "metadata";
        value: string;
      } | null;
      /**
       * One of 'avg', 'sum', 'min', 'max', 'median', 'all'
       */
      xAxisAggregation: /**
         * One of 'avg', 'sum', 'min', 'max', 'median', 'all'
         */
        | string
        /**
         * One of 'avg', 'sum', 'min', 'max', 'median', 'all'
         */
        | null;
      chartAnnotations: Array<{
        id: string;
        text: string;
      }> | null;
      timeRangeFilter:
        | string
        | {
            from: string;
            to: string;
          }
        | null;
      /**
       * @enum traces, spans, topics
       */
      queryShape:
        | /**
         * @enum traces, spans, topics
         */
        ("traces" | "spans" | "topics")
        /**
         * @enum traces, spans, topics
         */
        | null;
      cluster: string | null;
      freezeColumns: boolean | null;
    }>
  | null;
export type ViewType = {
  /**
   * Unique identifier for the view
   */
  id: string;
  object_type: AclObjectTypeType & string;
  /**
   * The id of the object the view applies to
   */
  object_id: string;
  /**
   * Type of object that the view corresponds to.
   *
   * @enum projects, experiments, experiment, playgrounds, playground, datasets, dataset, prompts, parameters, tools, scorers, classifiers, logs, monitor, for_review_project_log, for_review_experiments, for_review_datasets
   */
  view_type:
    | "projects"
    | "experiments"
    | "experiment"
    | "playgrounds"
    | "playground"
    | "datasets"
    | "dataset"
    | "prompts"
    | "parameters"
    | "tools"
    | "scorers"
    | "classifiers"
    | "logs"
    | "monitor"
    | "for_review_project_log"
    | "for_review_experiments"
    | "for_review_datasets";
  /**
   * Name of the view
   */
  name: string;
  description?:
    | /**
     * Textual description of the view
     */
    /**
     * Textual description of the view
     */
    (| string
        /**
         * Textual description of the view
         */
        | null
      )
    | undefined;
  created?:
    | /**
     * Date of view creation
     */
    /**
     * Date of view creation
     */
    (| string
        /**
         * Date of view creation
         */
        | null
      )
    | undefined;
  updated_at?:
    | /**
     * Date of last view update
     */
    /**
     * Date of last view update
     */
    (| string
        /**
         * Date of last view update
         */
        | null
      )
    | undefined;
  view_data?: ViewDataType | undefined;
  options?: ViewOptionsType | undefined;
  user_id?:
    | /**
     * Identifies the user who created the view
     */
    /**
     * Identifies the user who created the view
     */
    (| string
        /**
         * Identifies the user who created the view
         */
        | null
      )
    | undefined;
  deleted_at?:
    | /**
     * Date of role deletion, or null if the role is still active
     */
    /**
     * Date of role deletion, or null if the role is still active
     */
    (| string
        /**
         * Date of role deletion, or null if the role is still active
         */
        | null
      )
    | undefined;
};
