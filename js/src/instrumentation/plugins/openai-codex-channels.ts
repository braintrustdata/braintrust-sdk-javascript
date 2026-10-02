import { channel, defineInterceptor } from "../core/channel-definitions";

import type {
  OpenAICodexInput,
  OpenAICodexStreamedTurn,
  OpenAICodexThread,
  OpenAICodexThreadEvent,
  OpenAICodexTurn,
  OpenAICodexTurnOptions,
} from "../../vendor-sdk-types/openai-codex";

export const openAICodexChannels = defineInterceptor("@openai/codex-sdk", {
  run: channel<
    [OpenAICodexInput, OpenAICodexTurnOptions | undefined],
    PromiseLike<OpenAICodexTurn>,
    { operation?: "run"; thread?: OpenAICodexThread }
  >({
    channelName: "Thread.run",
  }),
  runStreamed: channel<
    [OpenAICodexInput, OpenAICodexTurnOptions | undefined],
    PromiseLike<OpenAICodexStreamedTurn>,
    { operation?: "runStreamed"; thread?: OpenAICodexThread },
    OpenAICodexThreadEvent
  >({
    channelName: "Thread.runStreamed",
  }),
});
