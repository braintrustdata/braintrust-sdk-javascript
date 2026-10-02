import type {
  TypeSafeSystemOneRequest,
  TypeSafeSystemOneResult,
} from "../../vendor-sdk-types/typesafe";
import { channel, defineInterceptor } from "../core/channel-definitions";

export const typeSafeChannels = defineInterceptor("@typesafe-ai/sdk", {
  systemOne: channel<
    [TypeSafeSystemOneRequest, options?: unknown],
    PromiseLike<TypeSafeSystemOneResult>
  >({
    channelName: "systemOne",
  }),
});
