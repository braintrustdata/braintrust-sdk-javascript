import { channel, defineInterceptor } from "../core/channel-definitions";

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

export const genkitChannels = defineInterceptor("@genkit-ai/ai", {
  generate: channel<[GenkitGenerateInput], PromiseLike<GenkitGenerateResponse>>(
    {
      channelName: "generate",
    },
  ),

  generateStream: channel<
    [GenkitGenerateInput],
    GenkitGenerateStreamResponse,
    Record<string, unknown>,
    GenkitGenerateResponseChunk
  >({
    channelName: "generateStream",
  }),

  embed: channel<[GenkitEmbedParams], PromiseLike<GenkitEmbedding[]>>({
    channelName: "embed",
  }),

  embedMany: channel<[GenkitEmbedManyParams], PromiseLike<unknown>>({
    channelName: "embedMany",
  }),

  actionRun: channel<[unknown, unknown?], PromiseLike<unknown>>({
    channelName: "action.run",
  }),

  actionStream: channel<
    [unknown, unknown?],
    ReturnType<NonNullable<GenkitAction["stream"]>>,
    Record<string, unknown>,
    unknown
  >({
    channelName: "action.stream",
  }),
});

export const genkitCoreChannels = defineInterceptor("@genkit-ai/core", {
  actionSpan: channel<[unknown, unknown, unknown?], PromiseLike<unknown>>({
    channelName: "action.span",
  }),
});
