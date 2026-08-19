import { channel, defineChannels } from "../core/channel-definitions";
import { INSTRUMENTATION_NAMES } from "../../span-origin";
import type {
  OpenAICodexInput,
  OpenAICodexStreamedTurn,
  OpenAICodexThread,
  OpenAICodexThreadEvent,
  OpenAICodexTurn,
  OpenAICodexTurnOptions,
} from "../../vendor-sdk-types/openai-codex";

export const openAICodexChannels = defineChannels(
  "@openai/codex-sdk",
  {
    run: channel<
      [OpenAICodexInput, OpenAICodexTurnOptions | undefined],
      OpenAICodexTurn,
      { operation?: "run"; thread?: OpenAICodexThread }
    >({
      channelName: "Thread.run",
      kind: "async",
    }),
    runStreamed: channel<
      [OpenAICodexInput, OpenAICodexTurnOptions | undefined],
      OpenAICodexStreamedTurn,
      { operation?: "runStreamed"; thread?: OpenAICodexThread },
      OpenAICodexThreadEvent
    >({
      channelName: "Thread.runStreamed",
      kind: "async",
    }),
  },
  { instrumentationName: INSTRUMENTATION_NAMES.OPENAI_CODEX },
);
