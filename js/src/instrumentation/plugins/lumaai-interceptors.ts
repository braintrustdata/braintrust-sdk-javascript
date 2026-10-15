import { channel, defineInterceptor } from "../core/interceptor-definitions";

export const lumaAIChannels = defineInterceptor("lumaai", {
  generationsCreate: channel<
    [body: unknown, options?: unknown],
    PromiseLike<unknown>
  >({
    channelName: "generations.create",
  }),
  generationsGet: channel<
    [id: string, options?: unknown],
    PromiseLike<unknown>
  >({
    channelName: "generations.get",
  }),
});
