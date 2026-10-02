import { channel, defineInterceptor } from "../core/channel-definitions";

import type {
  GoogleADKEvent,
  GoogleADKRunAsyncParams,
  GoogleADKToolRunRequest,
} from "../../vendor-sdk-types/google-adk";

type GoogleADKChannelContext = {
  self?: unknown;
};

/**
 * Channels for Google ADK instrumentation.
 *
 * runner.runAsync and agent.runAsync are async generators (yield Event objects),
 * so we use "sync-stream" kind — the function call returns the generator synchronously,
 * and the generator is consumed asynchronously.
 *
 * tool.runAsync is a regular async function returning Promise<unknown>,
 * so it uses "async" kind.
 */
export const googleADKChannels = defineInterceptor("@google/adk", {
  runnerRunAsync: channel<
    [GoogleADKRunAsyncParams],
    AsyncGenerator<GoogleADKEvent>,
    GoogleADKChannelContext,
    GoogleADKEvent
  >({
    channelName: "runner.runAsync",
  }),

  agentRunAsync: channel<
    [unknown],
    AsyncGenerator<GoogleADKEvent>,
    GoogleADKChannelContext,
    GoogleADKEvent
  >({
    channelName: "agent.runAsync",
  }),

  toolRunAsync: channel<
    [GoogleADKToolRunRequest],
    PromiseLike<unknown>,
    GoogleADKChannelContext
  >({
    channelName: "tool.runAsync",
  }),
});
