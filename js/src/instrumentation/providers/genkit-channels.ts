import { channel, defineChannels } from "../core/channel-definitions";
import { INSTRUMENTATION_NAMES } from "../../span-origin";
import type {
  GenkitAction,
  GenkitEmbedManyParams,
  GenkitEmbedParams,
  GenkitEmbedding,
  GenkitGenerateInput,
  GenkitGenerateResponse,
  GenkitGenerateResponseChunk,
  GenkitGenerateStreamResponse,
} from "../../vendor-sdk-types/genkit";

export const genkitChannels = defineChannels(
  "@genkit-ai/ai",
  {
    generate: channel<[GenkitGenerateInput], GenkitGenerateResponse>({
      channelName: "generate",
      kind: "async",
    }),

    generateStream: channel<
      [GenkitGenerateInput],
      GenkitGenerateStreamResponse,
      Record<string, unknown>,
      GenkitGenerateResponseChunk
    >({
      channelName: "generateStream",
      kind: "sync-stream",
    }),

    embed: channel<[GenkitEmbedParams], GenkitEmbedding[]>({
      channelName: "embed",
      kind: "async",
    }),

    embedMany: channel<[GenkitEmbedManyParams], unknown>({
      channelName: "embedMany",
      kind: "async",
    }),

    actionRun: channel<[unknown, unknown?], unknown>({
      channelName: "action.run",
      kind: "async",
    }),

    actionStream: channel<
      [unknown, unknown?],
      ReturnType<NonNullable<GenkitAction["stream"]>>,
      Record<string, unknown>,
      unknown
    >({
      channelName: "action.stream",
      kind: "sync-stream",
    }),
  },
  { instrumentationName: INSTRUMENTATION_NAMES.GENKIT },
);

export const genkitCoreChannels = defineChannels(
  "@genkit-ai/core",
  {
    actionSpan: channel<[unknown, unknown, unknown?], unknown>({
      channelName: "action.span",
      kind: "async",
    }),
  },
  { instrumentationName: INSTRUMENTATION_NAMES.GENKIT },
);
