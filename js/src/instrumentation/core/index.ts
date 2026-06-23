/**
 * Core utilities for building auto-instrumentation plugins.
 *
 * Provides BasePlugin class and channel utilities following the OpenTelemetry
 * InstrumentationBase pattern - core infrastructure lives here, but individual
 * instrumentations can be separate packages.
 *
 * Note: Orchestrion-specific types (InstrumentationConfig, ModuleMetadata, FunctionQuery)
 * should be imported directly from @apm-js-collab/code-transformer.
 */

export { BasePlugin } from "./plugin";
export { toLoggedError } from "./logging";
export {
  createChannelName,
  parseChannelName,
  isValidChannelName,
} from "./channel";
export type {
  BaseContext,
  ChannelSpanInfo,
  StartEvent,
  EndEvent,
  ErrorEvent,
  AsyncStartEvent,
  AsyncEndEvent,
  ChannelHandlers,
  SpanInfoCarrier,
} from "./types";
export type { StreamPatchOptions } from "./stream-patcher";
