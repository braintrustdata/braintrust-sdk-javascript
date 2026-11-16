import { channel, defineInterceptor } from "../core/interceptor-definitions";

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
    [CloudflareThinkTurnInput, historyLeafId?: string | null],
    PromiseLike<CloudflareThinkStreamableResult>,
    CloudflareThinkChannelContext
  >({
    channelName: "Think.runInferenceLoop",
  }),
});
