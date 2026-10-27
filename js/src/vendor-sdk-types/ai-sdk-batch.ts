import type { AISDKCallParams, AISDKResult } from "./ai-sdk";

/** The public experimental batch API in ai >=7.0.108 <8. */
export interface AISDKBatchReference {
  readonly version: 2;
  readonly id: string;
  readonly provider: string;
}

export interface AISDKBatchError {
  readonly message: string;
  readonly type?: string;
  readonly code?: string;
  readonly statusCode?: number;
}

export interface AISDKBatchStatus {
  readonly status: "pending" | "completed" | "failed";
  readonly rawStatus?: string;
  readonly requestCounts?: {
    readonly total: number;
    readonly pending: number;
    readonly completed: number;
    readonly failed: number;
  };
  readonly error?: AISDKBatchError;
  readonly createdAt?: string;
}

export type AISDKBatchRequest = AISDKCallParams & {
  id: string;
  type: "text" | "image";
  model: string;
};

export type AISDKBatchItem = AISDKResult & {
  readonly id: string;
  readonly type: "text" | "image";
  readonly status: "succeeded" | "failed" | "cancelled" | "expired";
  readonly error?: AISDKBatchError;
};

export interface StartAISDKBatchTraceArgs {
  batch: AISDKBatchReference & Partial<AISDKBatchStatus>;
  requests: ReadonlyArray<AISDKBatchRequest>;
  /** Unix timestamp in seconds, captured by the caller before submission. */
  startTime?: number;
}

export interface CompleteAISDKBatchTraceArgs {
  batch: AISDKBatchReference;
  requests: ReadonlyArray<AISDKBatchRequest>;
  status: AISDKBatchStatus;
  /** Already collected records. Lazy provider streams are not accepted. */
  results: ReadonlyArray<AISDKBatchItem>;
  /** Trusted application state returned by startAISDKBatchTrace. */
  context?: string;
  /** Unix timestamp in seconds from a verified terminal webhook, if available. */
  endTime?: number;
  denyOutputPaths?: string[];
}
