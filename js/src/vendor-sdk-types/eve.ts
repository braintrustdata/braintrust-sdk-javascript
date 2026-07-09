/**
 * Vendored types for eve's authored hook APIs.
 *
 * Keep this surface intentionally narrow. These types are not exported to SDK
 * users and should only cover fields we read, correlate, or log.
 */

export type EveJsonValue =
  | null
  | boolean
  | number
  | string
  | EveJsonValue[]
  | { readonly [key: string]: EveJsonValue };

export type EveJsonObject = { readonly [key: string]: EveJsonValue };

export interface EveHookContext {
  readonly agent?: {
    readonly name?: string;
    readonly nodeId?: string;
  };
  readonly channel?: {
    readonly kind?: string;
    readonly continuationToken?: string;
  };
  readonly session?: {
    readonly id?: string;
    readonly parent?: {
      readonly callId?: string;
      readonly rootSessionId?: string;
      readonly sessionId?: string;
      readonly turn?: {
        readonly id?: string;
        readonly sequence?: number;
      };
    };
  };
}

export type EveAssistantStepFinishReason =
  | "content-filter"
  | "error"
  | "length"
  | "other"
  | "stop"
  | "tool-calls";

export interface EveStreamEventMeta {
  readonly at: string;
}

export interface EveRuntimeToolCallActionRequest {
  readonly callId: string;
  readonly input: EveJsonObject;
  readonly kind: "tool-call";
  readonly toolName: string;
}

export interface EveRuntimeToolResultActionResult {
  readonly callId: string;
  readonly isError?: boolean;
  readonly kind: "tool-result";
  readonly output: EveJsonValue;
  readonly toolName: string;
}

export type EveRuntimeActionRequest =
  | EveRuntimeToolCallActionRequest
  | {
      readonly callId: string;
      readonly input?: EveJsonObject;
      readonly kind: "load-skill" | "remote-agent-call";
      readonly name?: string;
    }
  | {
      readonly callId: string;
      readonly input: EveJsonObject;
      readonly kind: "subagent-call";
      readonly name?: string;
      readonly subagentName?: string;
    };

export type EveRuntimeActionResult =
  | EveRuntimeToolResultActionResult
  | {
      readonly callId: string;
      readonly isError?: boolean;
      readonly kind: "load-skill-result";
      readonly output?: EveJsonValue;
      readonly name?: string;
    }
  | {
      readonly callId: string;
      readonly isError?: boolean;
      readonly kind: "subagent-result";
      readonly output?: EveJsonValue;
      readonly subagentName?: string;
    };

export type EveActionResultStatus = "completed" | "failed" | "rejected";

export interface EveActionResultError {
  readonly code: string;
  readonly message: string;
}

export type EveHandleMessageStreamEvent =
  | {
      readonly data: {
        readonly invocation?: unknown;
        readonly runtime?: {
          readonly agentId: string;
          readonly agentName?: string;
          readonly eveVersion: string;
          readonly modelId: string;
        };
      };
      readonly meta?: EveStreamEventMeta;
      readonly type: "session.started";
    }
  | {
      readonly data: {
        readonly sequence: number;
        readonly turnId: string;
      };
      readonly meta?: EveStreamEventMeta;
      readonly type: "turn.started";
    }
  | {
      readonly data: {
        readonly sequence: number;
        readonly turnId: string;
      };
      readonly meta?: EveStreamEventMeta;
      readonly type: "turn.completed";
    }
  | {
      readonly data: {
        readonly message: string;
        readonly sequence: number;
        readonly turnId: string;
      };
      readonly meta?: EveStreamEventMeta;
      readonly type: "message.received";
    }
  | {
      readonly data: {
        readonly finishReason: EveAssistantStepFinishReason;
        readonly message: string | null;
        readonly sequence: number;
        readonly stepIndex: number;
        readonly turnId: string;
      };
      readonly meta?: EveStreamEventMeta;
      readonly type: "message.completed";
    }
  | {
      readonly data: {
        readonly result: EveJsonValue;
        readonly sequence: number;
        readonly stepIndex: number;
        readonly turnId: string;
      };
      readonly meta?: EveStreamEventMeta;
      readonly type: "result.completed";
    }
  | {
      readonly data: {
        readonly sequence: number;
        readonly stepIndex: number;
        readonly turnId: string;
      };
      readonly meta?: EveStreamEventMeta;
      readonly type: "step.started";
    }
  | {
      readonly data: {
        readonly finishReason: EveAssistantStepFinishReason;
        readonly providerMetadata?: {
          readonly gateway?: {
            readonly generationId?: string;
          };
        };
        readonly sequence: number;
        readonly stepIndex: number;
        readonly turnId: string;
        readonly usage?: {
          readonly cacheReadTokens?: number;
          readonly cacheWriteTokens?: number;
          readonly costUsd?: number;
          readonly inputTokens?: number;
          readonly outputTokens?: number;
        };
      };
      readonly meta?: EveStreamEventMeta;
      readonly type: "step.completed";
    }
  | {
      readonly data: {
        readonly code: string;
        readonly details?: EveJsonObject;
        readonly message: string;
        readonly sequence: number;
        readonly stepIndex: number;
        readonly turnId: string;
      };
      readonly meta?: EveStreamEventMeta;
      readonly type: "step.failed";
    }
  | {
      readonly data: {
        readonly actions: readonly EveRuntimeActionRequest[];
        readonly sequence: number;
        readonly stepIndex: number;
        readonly turnId: string;
      };
      readonly meta?: EveStreamEventMeta;
      readonly type: "actions.requested";
    }
  | {
      readonly data: {
        readonly error?: EveActionResultError;
        readonly result: EveRuntimeActionResult;
        readonly sequence: number;
        readonly stepIndex: number;
        readonly status: EveActionResultStatus;
        readonly turnId: string;
      };
      readonly meta?: EveStreamEventMeta;
      readonly type: "action.result";
    }
  | {
      readonly data: {
        readonly callId: string;
        readonly childSessionId: string;
        readonly name: string;
        readonly remote?: {
          readonly url?: string;
        };
        readonly sequence: number;
        readonly toolName?: string;
        readonly turnId: string;
      };
      readonly meta?: EveStreamEventMeta;
      readonly type: "subagent.called";
    }
  | {
      readonly data: {
        readonly callId: string;
        readonly error?: EveActionResultError;
        readonly output?: EveJsonValue;
        readonly sequence: number;
        readonly status?: EveActionResultStatus;
        readonly subagentName: string;
        readonly turnId: string;
      };
      readonly meta?: EveStreamEventMeta;
      readonly type: "subagent.completed";
    }
  | {
      readonly data: {
        readonly code: string;
        readonly details?: EveJsonObject;
        readonly message: string;
        readonly sequence: number;
        readonly turnId: string;
      };
      readonly meta?: EveStreamEventMeta;
      readonly type: "turn.failed";
    }
  | {
      readonly data: {
        readonly code: string;
        readonly details?: EveJsonObject;
        readonly message: string;
        readonly sessionId: string;
      };
      readonly meta?: EveStreamEventMeta;
      readonly type: "session.failed";
    }
  | {
      readonly data: {
        readonly wait: "next-user-message";
      };
      readonly meta?: EveStreamEventMeta;
      readonly type: "session.waiting";
    }
  | {
      readonly meta?: EveStreamEventMeta;
      readonly type: "session.completed";
    };

export interface EveHookDefinition {
  readonly events?: {
    readonly "*"?: (
      event: EveHandleMessageStreamEvent,
      ctx: EveHookContext,
    ) => void | Promise<void>;
    readonly [eventType: string]:
      | ((
          event: EveHandleMessageStreamEvent,
          ctx: EveHookContext,
        ) => void | Promise<void>)
      | undefined;
  };
}
