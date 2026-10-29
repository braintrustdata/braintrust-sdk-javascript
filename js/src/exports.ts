/**
 * The public `braintrust` package surface.
 *
 * Keep this file as an explicit allowlist. Implementation details should stay
 * private; integrations belong on narrow, intentional extension points.
 */

export type {
  ContextParentSpanIds,
  CurrentSpanStore,
  PropagationContext,
  Span,
  StartSpanArgs,
} from "./logger/core";

export { wrapConsole } from "./logs";
export {
  Attachment,
  BaseAttachment,
  BraintrustState,
  ExternalAttachment,
  JSONAttachment,
  Logger,
  NOOP_SPAN,
  ReadonlyAttachment,
  _internalCaptureAttachmentsEnabled,
  currentExperiment,
  currentLogger,
  currentSpan,
  configureContextManager,
  ContextManager,
  extractTraceContextFromHeaders,
  flush,
  injectTraceContext,
  initLogger,
  logError,
  login,
  loginToState,
  setFetch,
  setMaskingFunction,
  startSpan,
  traced,
  updateSpan,
  withCurrent,
  withParent,
  wrapTraced,
} from "./logger/core";
export { Dataset, initDataset } from "./logger/datasets";
export { Experiment, ReadonlyExperiment, init } from "./logger/experiments";
export {
  Prompt,
  getPromptVersions,
  loadParameters,
  loadPrompt,
} from "./logger/prompts";

export { registerSandbox } from "./sandbox";

export { startAISDKBatchTrace, completeAISDKBatchTrace } from "./ai-sdk-batch";

export {
  completeOpenAIBatchTrace,
  openaiBatchesRetrieveTraced,
  openaiFilesCreateTraced,
} from "./openai-batch";

export type { TemplateRendererPlugin } from "./template/registry";
export { registerTemplatePlugin } from "./template/registry";
export {
  failOpenAIAgentsTrace,
  startOpenAIAgentsTrace,
  updateOpenAIAgentsTrace,
} from "./openai-agents-api";

export {
  isTemplateFormat,
  parseTemplateFormat,
  renderTemplateContent,
} from "./template/renderer";

export { initFunction, invoke } from "./functions/invoke";
export { BraintrustStream } from "./functions/stream";

export { wrapOpenAI } from "./wrappers/oai";
export {
  braintrustAISDKTelemetry,
  wrapAISDK,
  wrapAgentClass,
} from "./wrappers/ai-sdk";
export { collectAnthropicSession } from "./wrappers/anthropic-session-collector";
export { wrapAnthropic } from "./wrappers/anthropic";
export { BraintrustObservabilityExporter } from "./wrappers/mastra";
export { wrapClaudeAgentSDK } from "./wrappers/claude-agent-sdk/claude-agent-sdk";
export { wrapCloudflareThink } from "./wrappers/cloudflare-think";
export { wrapOpenAICodexSDK } from "./wrappers/openai-codex";
export { wrapCursorSDK } from "./wrappers/cursor-sdk";
export { wrapPiCodingAgentSDK } from "./wrappers/pi-coding-agent";
export { wrapCloudflareAgent } from "./wrappers/cloudflare-agent";
export { wrapStrandsAgentSDK } from "./wrappers/strands-agent-sdk";
export { wrapCloudflareAIChat } from "./wrappers/cloudflare-ai-chat";
export { wrapGoogleGenerativeAI } from "./wrappers/google-generative-ai";
export { wrapGoogleGenAI } from "./wrappers/google-genai";
export { wrapGoogleADK } from "./wrappers/google-adk";
export { wrapGenkit } from "./wrappers/genkit";
export { wrapHuggingFace } from "./wrappers/huggingface";
export { wrapHuggingFaceTransformers } from "./wrappers/huggingface-transformers";
export { wrapLiveKit } from "./wrappers/livekit";
export { wrapOpenRouterAgent } from "./wrappers/openrouter-agent";
export { wrapOpenRouter } from "./wrappers/openrouter";
export { wrapMistral } from "./wrappers/mistral";
export { wrapLangGraphSDK } from "./wrappers/langgraph-sdk";
export { wrapOllama } from "./wrappers/ollama";
export { wrapCohere } from "./wrappers/cohere";
export { wrapVoyageAI } from "./wrappers/voyageai";
export { wrapMCPServer } from "./wrappers/mcp";
export { wrapWorkersAI } from "./wrappers/workers-ai";
export { wrapTypeSafe } from "./wrappers/typesafe";
export { wrapGroq } from "./wrappers/groq";
export { wrapBedrockRuntime } from "./wrappers/bedrock-runtime";
export { wrapCopilotClient } from "./wrappers/github-copilot";
export {
  wrapLangSmithClient,
  wrapLangSmithRunTrees,
  wrapLangSmithTraceable,
} from "./wrappers/langsmith";
export { wrapVitest } from "./wrappers/vitest";
export { initNodeTestSuite } from "./wrappers/node-test";
export { BraintrustLangChainCallbackHandler } from "./wrappers/langchain/callback-handler";
export type { LangChainCallbackHandlerOptions } from "./vendor-sdk-types/langchain";

export type {
  Evaluator,
  EvalTask,
  EvalScorer,
  EvalClassifier,
  ReporterBody,
} from "./framework";
export {
  BaseExperiment,
  Eval,
  Reporter,
  defaultErrorScoreHandler,
} from "./framework";

export type { WorkflowEvalStore } from "./workflow-eval";
export {
  WorkflowBatchScorer,
  WorkflowBatchTask,
  WorkflowScorer,
  WorkflowTask,
  defineWorkflowEval,
  WorkflowEvalMemoryStore,
  WorkflowEvalRedisStore,
} from "./workflow-eval";

export { agentAssertionScorer } from "./agent-assertions";
export { DatasetPipeline } from "./dataset-pipeline";
export { projects } from "./framework2";

export type { Trace } from "./trace";
export { LocalTrace } from "./trace";

export { wrapElevenLabs } from "./wrappers/elevenlabs";
