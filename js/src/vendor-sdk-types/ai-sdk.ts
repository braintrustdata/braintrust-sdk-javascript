import type {
  AISDKAgentClass,
  AISDKAgentInstance,
  AISDKCallParams,
  AISDKEmbedFunction,
  AISDKEmbedParams,
  AISDKEmbeddingResult,
  AISDKGeneratedFile,
  AISDKGenerateFunction,
  AISDKLanguageModel,
  AISDKMessage,
  AISDKModel,
  AISDKModelStreamChunk,
  AISDKNamespaceBase,
  AISDKOutputObject,
  AISDKOutputResponseFormat,
  AISDKProviderMetadata,
  AISDKProviderResolver,
  AISDKResult,
  AISDKStepResult,
  AISDKStreamFunction,
  AISDKSyncOutputObject,
  AISDKAsyncOutputObject,
  AISDKTool,
  AISDKTools,
  AISDKTokenBucket,
  AISDKUsage,
} from "./ai-sdk-common";
import type { AISDKV3 } from "./ai-sdk-v3";
import type { AISDKV4 } from "./ai-sdk-v4";
import type { AISDKV5 } from "./ai-sdk-v5";
import type { AISDKV6 } from "./ai-sdk-v6";

export type AISDKVersion =
  | { majorVersion: 3; sdk: AISDKV3 }
  | { majorVersion: 4; sdk: AISDKV4 }
  | { majorVersion: 5; sdk: AISDKV5 }
  | { majorVersion: 6; sdk: AISDKV6 };

export type AISDK = AISDKVersion["sdk"];

export type {
  AISDKAgentClass,
  AISDKAgentInstance,
  AISDKAsyncOutputObject,
  AISDKCallParams,
  AISDKEmbedFunction,
  AISDKEmbedParams,
  AISDKEmbeddingResult,
  AISDKGeneratedFile,
  AISDKGenerateFunction,
  AISDKLanguageModel,
  AISDKMessage,
  AISDKModel,
  AISDKModelStreamChunk,
  AISDKNamespaceBase,
  AISDKOutputObject,
  AISDKOutputResponseFormat,
  AISDKProviderMetadata,
  AISDKProviderResolver,
  AISDKResult,
  AISDKStepResult,
  AISDKStreamFunction,
  AISDKSyncOutputObject,
  AISDKTool,
  AISDKTools,
  AISDKTokenBucket,
  AISDKUsage,
};
