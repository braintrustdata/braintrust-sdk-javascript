import { channel, defineInterceptor } from "../core/channel-definitions";

import type {
  AISDK,
  AISDKCallParams,
  AISDKEmbedParams,
  AISDKEmbeddingResult,
  AISDKEvaluateParams,
  AISDKEvaluationResult,
  AISDKGenerateImageParams,
  AISDKHarnessAgentCallParams,
  AISDKHarnessAgentCreateSessionParams,
  AISDKHarnessAgentSession,
  AISDKLanguageModel,
  AISDKModelStreamChunk,
  AISDKRerankParams,
  AISDKRerankResult,
  AISDKResult,
} from "../../vendor-sdk-types/ai-sdk";
import type {
  AISDKV7CreateTelemetryDispatcherArgs,
  AISDKV7TelemetryDispatcher,
} from "../../vendor-sdk-types/ai-sdk-v7-telemetry";
import type { ChannelSpanInfo } from "../core/types";

type AISDKStreamResult = AISDKResult | AsyncIterable<unknown>;
type AISDKChannelContext = {
  aiSDK?: AISDK;
  denyOutputPaths?: string[];
  self?: unknown;
  span_info?: ChannelSpanInfo;
};

type AISDKModelChannelContext = {
  denyOutputPaths?: string[];
  model: AISDKLanguageModel;
};

export const BRAINTRUST_WRAPPED_AI_SDK_MODEL = Symbol.for(
  "braintrust.ai-sdk.wrapped-model",
);

export const aiSDKChannels = defineInterceptor("ai", {
  modelGenerate: channel<
    [AISDKCallParams],
    PromiseLike<AISDKResult>,
    AISDKModelChannelContext
  >({
    channelName: "model.doGenerate",
  }),
  modelStream: channel<
    [AISDKCallParams],
    PromiseLike<
      AISDKResult & { stream: ReadableStream<AISDKModelStreamChunk> }
    >,
    AISDKModelChannelContext
  >({
    channelName: "model.doStream",
  }),
  evaluate: channel<
    [AISDKEvaluateParams],
    PromiseLike<AISDKEvaluationResult>,
    AISDKChannelContext
  >({
    channelName: "evaluate",
  }),
  generateText: channel<
    [AISDKCallParams],
    PromiseLike<AISDKStreamResult> | AISDKStreamResult,
    AISDKChannelContext,
    unknown
  >({
    channelName: "generateText",
  }),
  generateImage: channel<
    [AISDKGenerateImageParams],
    PromiseLike<AISDKResult>,
    AISDKChannelContext
  >({
    channelName: "generateImage",
  }),
  streamText: channel<
    [AISDKCallParams],
    PromiseLike<AISDKStreamResult> | AISDKStreamResult,
    AISDKChannelContext,
    unknown
  >({
    channelName: "streamText",
  }),
  streamTextSync: channel<
    [AISDKCallParams],
    AISDKResult,
    AISDKChannelContext,
    unknown
  >({
    channelName: "streamText.sync",
  }),
  generateObject: channel<
    [AISDKCallParams],
    PromiseLike<AISDKStreamResult> | AISDKStreamResult,
    AISDKChannelContext,
    unknown
  >({
    channelName: "generateObject",
  }),
  streamObject: channel<
    [AISDKCallParams],
    PromiseLike<AISDKStreamResult> | AISDKStreamResult,
    AISDKChannelContext,
    unknown
  >({
    channelName: "streamObject",
  }),
  streamObjectSync: channel<
    [AISDKCallParams],
    AISDKResult,
    AISDKChannelContext,
    unknown
  >({
    channelName: "streamObject.sync",
  }),
  embed: channel<
    [AISDKEmbedParams],
    PromiseLike<AISDKEmbeddingResult>,
    AISDKChannelContext
  >({
    channelName: "embed",
  }),
  embedMany: channel<
    [AISDKEmbedParams],
    PromiseLike<AISDKEmbeddingResult>,
    AISDKChannelContext
  >({
    channelName: "embedMany",
  }),
  rerank: channel<
    [AISDKRerankParams],
    PromiseLike<AISDKRerankResult>,
    AISDKChannelContext
  >({
    channelName: "rerank",
  }),
  agentGenerate: channel<
    [AISDKCallParams],
    PromiseLike<AISDKStreamResult> | AISDKStreamResult,
    AISDKChannelContext,
    unknown
  >({
    channelName: "Agent.generate",
  }),
  agentStream: channel<
    [AISDKCallParams],
    PromiseLike<AISDKStreamResult> | AISDKStreamResult,
    AISDKChannelContext,
    unknown
  >({
    channelName: "Agent.stream",
  }),
  agentStreamSync: channel<
    [AISDKCallParams],
    AISDKResult,
    AISDKChannelContext,
    unknown
  >({
    channelName: "Agent.stream.sync",
  }),
  toolLoopAgentGenerate: channel<
    [AISDKCallParams],
    PromiseLike<AISDKStreamResult> | AISDKStreamResult,
    AISDKChannelContext,
    unknown
  >({
    channelName: "ToolLoopAgent.generate",
  }),
  toolLoopAgentStream: channel<
    [AISDKCallParams],
    PromiseLike<AISDKStreamResult> | AISDKStreamResult,
    AISDKChannelContext,
    unknown
  >({
    channelName: "ToolLoopAgent.stream",
  }),
  workflowAgentStream: channel<
    [AISDKCallParams],
    PromiseLike<AISDKStreamResult> | AISDKStreamResult,
    AISDKChannelContext,
    unknown
  >({
    channelName: "WorkflowAgent.stream",
  }),
  v7CreateTelemetryDispatcher: channel<
    [AISDKV7CreateTelemetryDispatcherArgs],
    AISDKV7TelemetryDispatcher
  >({
    channelName: "createTelemetryDispatcher",
  }),
});

export const harnessAgentChannels = defineInterceptor("@ai-sdk/harness", {
  createSession: channel<
    [AISDKHarnessAgentCreateSessionParams?],
    PromiseLike<AISDKHarnessAgentSession>,
    AISDKChannelContext
  >({
    channelName: "HarnessAgent.createSession",
  }),
  generate: channel<
    [AISDKHarnessAgentCallParams],
    PromiseLike<AISDKStreamResult> | AISDKStreamResult,
    AISDKChannelContext,
    unknown
  >({
    channelName: "HarnessAgent.generate",
  }),
  stream: channel<
    [AISDKHarnessAgentCallParams],
    PromiseLike<AISDKStreamResult> | AISDKStreamResult,
    AISDKChannelContext,
    unknown
  >({
    channelName: "HarnessAgent.stream",
  }),
  continueGenerate: channel<
    [AISDKHarnessAgentCallParams],
    PromiseLike<AISDKStreamResult> | AISDKStreamResult,
    AISDKChannelContext,
    unknown
  >({
    channelName: "HarnessAgent.continueGenerate",
  }),
  continueStream: channel<
    [AISDKHarnessAgentCallParams],
    PromiseLike<AISDKStreamResult> | AISDKStreamResult,
    AISDKChannelContext,
    unknown
  >({
    channelName: "HarnessAgent.continueStream",
  }),
});
