import { channel, defineInterceptor } from "../core/interceptor-definitions";
import type {
  FalArgs,
  FalClient,
  FalResult,
  FalStream,
} from "../../vendor-sdk-types/fal";

export const falChannels = defineInterceptor("@fal-ai/client", {
  createClient: channel<[unknown?], FalClient>({
    channelName: "createFalClient",
  }),
  run: channel<FalArgs, Promise<FalResult>>({ channelName: "run" }),
  stream: channel<FalArgs, Promise<FalStream>>({ channelName: "stream" }),
});
