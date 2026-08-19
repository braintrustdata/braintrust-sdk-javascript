import { channel, defineChannels } from "../core/channel-definitions";
import { INSTRUMENTATION_NAMES } from "../../span-origin";
import type { FlueObservableContext } from "../../vendor-sdk-types/flue";

export const flueChannels = defineChannels(
  "@flue/runtime",
  {
    createContext: channel<[unknown], FlueObservableContext>({
      channelName: "createFlueContext",
      kind: "sync-stream",
    }),
  },
  { instrumentationName: INSTRUMENTATION_NAMES.FLUE },
);
