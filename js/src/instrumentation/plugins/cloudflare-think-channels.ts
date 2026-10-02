import { channel, defineInterceptor } from "../core/channel-definitions";

import type {
  CloudflareThinkInstance,
  CloudflareThinkStreamableResult,
  CloudflareThinkTurnInput,
} from "../../vendor-sdk-types/cloudflare-think";

type CloudflareThinkChannelContext = {
  self?: CloudflareThinkInstance;
  moduleVersion?: string;
};

export const cloudflareThinkChannels = defineInterceptor("@cloudflare/think", {
  runInferenceLoop: channel<
    [CloudflareThinkTurnInput],
    PromiseLike<CloudflareThinkStreamableResult>,
    CloudflareThinkChannelContext
  >({
    channelName: "Think.runInferenceLoop",
  }),
});
