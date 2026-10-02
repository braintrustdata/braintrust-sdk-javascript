/**
 * Instrumentation APIs for auto-instrumentation.
 *
 * This module provides the core plugin infrastructure for registering invocation
 * interceptors that trace provider calls.
 *
 * Following the OpenTelemetry pattern, BasePlugin (like InstrumentationBase)
 * lives in the core SDK, while individual instrumentation implementations
 * can be separate packages.
 *
 * For auto-instrumentation config types, import InstrumentationConfig from the
 * relevant Braintrust bundler subpath such as `braintrust/vite`.
 *
 * @module instrumentation
 */

export { BraintrustPlugin } from "./braintrust-plugin";
export type { BraintrustPluginConfig } from "./braintrust-plugin";
export { BasePlugin } from "./core";
export { braintrustEveInstrumentation } from "./plugins/eve-instrumentation";
export { braintrustEveHook } from "./plugins/eve-plugin";
export {
  braintrustFlueInstrumentation,
  braintrustFlueObserver,
} from "./plugins/flue-plugin";
export { OpenAIAgentsTraceProcessor } from "./plugins/openai-agents-trace-processor";
export type { OpenAIAgentsTraceProcessorOptions } from "./plugins/openai-agents-trace-processor";

// Re-export core types for external instrumentation packages
export {
  createChannelName,
  isValidChannelName,
  parseChannelName,
} from "./core";
export type {
  AsyncEndEvent,
  AsyncStartEvent,
  BaseContext,
  EndEvent,
  ErrorEvent,
  StartEvent,
} from "./core";

// Configuration API
export type { SpanCustomizer, SpanExportData } from "./config";
export { configureInstrumentation } from "./registry";
export type { InstrumentationConfig } from "./registry";
