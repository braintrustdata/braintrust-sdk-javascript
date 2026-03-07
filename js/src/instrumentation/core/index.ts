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
export { channel, defineChannels } from "./channel-spec";
export {
  createChannelName,
  parseChannelName,
  isValidChannelName,
} from "./channel";
export { isAsyncIterable, patchStreamIfNeeded } from "./stream-patcher";
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
} from "./channel-spec";
export type {
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
} from "./types";
export type { StreamPatchOptions } from "./stream-patcher";
