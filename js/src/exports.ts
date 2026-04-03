export type {
  AnyDataset,
  AttachmentParams,
  BackgroundLoggerOpts,
  BaseMetadata,
  ChatPrompt,
  CompiledPrompt,
  CompiledPromptParams,
  CompletionPrompt,
  ContextParentSpanIds,
  DataSummary,
  DatasetSummary,
  DefaultMetadataType,
  DefaultPromptArgs,
  EndSpanArgs,
  EvalCase,
  ExperimentSummary,
  Exportable,
  ExternalAttachmentParams,
  FullInitDatasetOptions,
  FullInitOptions,
  FullLoginOptions,
  InitDatasetOptions,
  InitLoggerOptions,
  InitOptions,
  LoadPromptOptions,
  LogOptions,
  LoginOptions,
  Logs3OverflowInputRow,
  Logs3OverflowUpload,
  MetricSummary,
  ObjectMetadata,
  PromiseUnless,
  PromptRowWithId,
  ScoreSummary,
  SerializedBraintrustState,
  SetCurrentArg,
  Span,
  StartSpanArgs,
  WithTransactionId,
} from "./logger";

export type {
  SandboxConfig,
  RegisterSandboxOptions,
  RegisterSandboxResult,
} from "./sandbox";

export {
  Attachment,
  BaseAttachment,
  BRAINTRUST_CURRENT_SPAN_STORE,
  BraintrustState,
  ContextManager,
  CurrentSpanStore,
  DEFAULT_FETCH_BATCH_SIZE,
  DEFAULT_MAX_REQUEST_SIZE,
  Dataset,
  ObjectFetcher,
  ERR_PERMALINK,
  Experiment,
  ExternalAttachment,
  FailedHTTPResponse,
  JSONAttachment,
  LOGS3_OVERFLOW_REFERENCE_TYPE,
  Logger,
  LoginInvalidOrgError,
  NOOP_SPAN,
  NOOP_SPAN_PERMALINK,
  NoopSpan,
  Prompt,
  ReadonlyAttachment,
  ReadonlyExperiment,
  SpanImpl,
  TestBackgroundLogger,
  _exportsForTestingOnly,
  _internalGetGlobalState,
  _internalSetInitialState,
  constructLogs3OverflowRequest,
  currentExperiment,
  currentLogger,
  currentSpan,
  deepCopyEvent,
  deserializePlainStringAsJSON,
  flush,
  getContextManager,
  getPromptVersions,
  getSpanParentObject,
  init,
  initDataset,
  initExperiment,
  initLogger,
  loadParameters,
  loadPrompt,
  log,
  logError,
  login,
  loginToState,
  logs3OverflowUploadSchema,
  newId,
  permalink,
  pickLogs3OverflowObjectIds,
  uploadLogs3OverflowPayload,
  utf8ByteLength,
  renderMessage,
  renderPromptParams,
  setFetch,
  setMaskingFunction,
  spanComponentsToObjectId,
  startSpan,
  summarize,
  traceable,
  traced,
  updateSpan,
  withCurrent,
  withDataset,
  withExperiment,
  withLogger,
  withParent,
  wrapTraced,
  registerOtelFlush,
} from "./logger";

export { registerSandbox } from "./sandbox";

// Internal isomorph layer for platform-specific implementations
import _internalIso from "./isomorph";
export { _internalIso };

export {
  isTemplateFormat,
  parseTemplateFormat,
  renderTemplateContent,
} from "./template/renderer";
export type { TemplateFormat } from "./template/registry";

export type {
  TemplateRenderer,
  TemplateRendererPlugin,
} from "./template/registry";
export {
  registerTemplatePlugin,
  getTemplateRenderer,
  templateRegistry,
} from "./template/registry";

export type { InvokeFunctionArgs, InvokeReturn } from "./functions/invoke";
export { initFunction, invoke } from "./functions/invoke";

export type { BraintrustStreamChunk } from "./functions/stream";
export {
  BraintrustStream,
  braintrustStreamChunkSchema,
  createFinalValuePassThroughStream,
  devNullWritableStream,
} from "./functions/stream";

export { IDGenerator, UUIDGenerator, getIdGenerator } from "./id-gen";

export {
  LEGACY_CACHED_HEADER,
  X_CACHED_HEADER,
  parseCachedHeader,
  wrapOpenAI,
  wrapOpenAIv4,
} from "./wrappers/oai";

export {
  wrapAISDK,
  wrapAgentClass,
  BraintrustMiddleware,
  wrapAISDKModel,
} from "./wrappers/ai-sdk";
export { wrapAnthropic } from "./wrappers/anthropic";
export { wrapMastraAgent } from "./wrappers/mastra";
export { wrapClaudeAgentSDK } from "./wrappers/claude-agent-sdk/claude-agent-sdk";
export { wrapGoogleGenAI } from "./wrappers/google-genai";
export { wrapOpenRouter } from "./wrappers/openrouter";
export { wrapMistral } from "./wrappers/mistral";
export { wrapVitest } from "./wrappers/vitest";
export { initNodeTestSuite } from "./wrappers/node-test";

export * as graph from "./graph-framework";

export type {
  Evaluator,
  EvalTask,
  EvalHooks,
  EvalResult,
  EvalScorerArgs,
  EvalScorer,
  EvaluatorDef,
  EvaluatorFile,
  ReporterBody,
  SpanContext,
} from "./framework";

export {
  BaseExperiment,
  Eval,
  EvalResultWithSummary,
  Reporter,
  buildLocalSummary,
  reportFailures,
  runEvaluator,
  defaultErrorScoreHandler,
} from "./framework";

export type {
  CodeOpts,
  CreateProjectOpts,
  FunctionEvent,
  PromptOpts,
  ScorerOpts,
} from "./framework2";

export {
  CodeFunction,
  CodePrompt,
  Project,
  ProjectNameIdMap,
  PromptBuilder,
  ScorerBuilder,
  ToolBuilder,
  projects,
  toolFunctionDefinitionSchema,
} from "./framework2";

export {
  promptContentsSchema,
  promptDefinitionSchema,
  promptDefinitionToPromptData,
  promptDefinitionWithToolsSchema,
  PromptContents,
  PromptDefinition,
  PromptDefinitionWithTools,
} from "./prompt-schemas";

export type { Trace, SpanData, GetThreadOptions } from "./trace";
export { SpanFetcher, CachedSpanFetcher } from "./trace";

export type {
  ParentExperimentIds,
  ParentProjectLogIds,
  IdField,
  InputField,
  OtherExperimentLogFields,
  ExperimentLogPartialArgs,
  ExperimentLogFullArgs,
  LogFeedbackFullArgs,
  LogCommentFullArgs,
  CommentEvent,
  DatasetRecord,
} from "../util";

export { addAzureBlobHeaders, LazyValue } from "./util";

export { AttachmentReference } from "./generated_types";

export type {
  EvaluatorManifest,
  EvalParameterSerializedSchema,
  EvaluatorDefinition,
  EvaluatorDefinitions,
  ParametersSource,
} from "../dev/types";

export type { EvalParameters } from "./eval-parameters";

export {
  evaluatorDefinitionSchema,
  evaluatorDefinitionsSchema,
} from "../dev/types";

// Auto-instrumentation configuration
export { configureInstrumentation } from "./instrumentation";
export type { InstrumentationConfig } from "./instrumentation";
