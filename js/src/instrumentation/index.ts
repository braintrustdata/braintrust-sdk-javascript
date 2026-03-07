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
 * For orchestrion-js configuration types (InstrumentationConfig, ModuleMetadata, FunctionQuery),
 * import directly from @apm-js-collab/code-transformer.
 *
 * @module instrumentation
 */

export { BasePlugin } from "./core";
export { channel, defineChannels } from "./core";
export { BraintrustPlugin } from "./braintrust-plugin";
export type { BraintrustPluginConfig } from "./braintrust-plugin";

// Re-export core types for external instrumentation packages
export type {
  ChannelKind,
  ChannelMap,
  ChannelMessage,
  ChannelSpec,
  AnyTypedChannel,
  AnyAsyncChannel,
  AnySyncStreamChannel,
  TypedChannel,
  TypedAsyncChannel,
  TypedSyncStreamChannel,
  ArgsOf,
  ResultOf,
  ExtraOf,
  ChunkOf,
  StartOf,
  AsyncEndOf,
  EndOf,
  ErrorOf,
  EventArguments,
  BaseContext,
  StartEvent,
  EndEvent,
  ErrorEvent,
  AsyncStartEvent,
  AsyncEndEvent,
  StartEventWith,
  EndEventWith,
  AsyncEndEventWith,
  ErrorEventWith,
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
