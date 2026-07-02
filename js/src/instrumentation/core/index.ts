/**
 * Core utilities for building auto-instrumentation plugins.
 *
 * Provides BasePlugin class and channel utilities following the OpenTelemetry
 * InstrumentationBase pattern - core infrastructure lives here, but individual
 * instrumentations can be separate packages.
 *
 * Note: auto-instrumentation config types are exposed from the Braintrust
 * bundler subpaths, such as `braintrust/vite`.
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
