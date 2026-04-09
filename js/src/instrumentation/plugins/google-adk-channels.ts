import { channel, defineChannels } from "../core/channel-definitions";
import type {
  GoogleADKRunAsyncParams,
  GoogleADKEvent,
  GoogleADKToolRunRequest,
} from "../../vendor-sdk-types/google-adk";

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
export const googleADKChannels = defineChannels("@google/adk", {
  runnerRunAsync: channel<
    [GoogleADKRunAsyncParams],
    AsyncGenerator<GoogleADKEvent>,
    Record<string, unknown>,
    GoogleADKEvent
  >({
    channelName: "runner.runAsync",
    kind: "sync-stream",
  }),

  agentRunAsync: channel<
    [unknown],
    AsyncGenerator<GoogleADKEvent>,
    Record<string, unknown>,
    GoogleADKEvent
  >({
    channelName: "agent.runAsync",
    kind: "sync-stream",
  }),

  toolRunAsync: channel<[GoogleADKToolRunRequest], unknown>({
    channelName: "tool.runAsync",
    kind: "async",
  }),
});
