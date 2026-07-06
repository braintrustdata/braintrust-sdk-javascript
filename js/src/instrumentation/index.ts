/**
 * Instrumentation APIs for auto-instrumentation.
 *
 * This module provides the core plugin infrastructure for converting
 * diagnostics_channel events into Braintrust spans.
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

export { BasePlugin } from "./core";
export { BraintrustPlugin } from "./braintrust-plugin";
export type { BraintrustPluginConfig } from "./braintrust-plugin";
export { OpenAIAgentsTraceProcessor } from "./plugins/openai-agents-trace-processor";
export type { OpenAIAgentsTraceProcessorOptions } from "./plugins/openai-agents-trace-processor";
export {
  braintrustFlueInstrumentation,
  braintrustFlueObserver,
} from "./plugins/flue-plugin";
export { braintrustEveHook } from "./plugins/eve-plugin";

// Re-export core types for external instrumentation packages
export type {
  BaseContext,
  StartEvent,
  EndEvent,
  ErrorEvent,
  AsyncStartEvent,
  AsyncEndEvent,
  ChannelHandlers,
} from "./core";
export {
  createChannelName,
  parseChannelName,
  isValidChannelName,
} from "./core";

// Configuration API
export { configureInstrumentation } from "./registry";
export type { InstrumentationConfig } from "./registry";
