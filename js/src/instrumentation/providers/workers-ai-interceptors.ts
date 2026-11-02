import type { WorkersAI } from "../../vendor-sdk-types/workers-ai";
import { channel, defineInterceptor } from "../core/interceptor-definitions";

export const workersAIChannels = defineInterceptor("workers-ai", {
  run: channel<Parameters<WorkersAI["run"]>, ReturnType<WorkersAI["run"]>>({
    channelName: "run",
  }),
});
