import { channel, defineChannels } from "../core/channel-definitions";
import type { FlueObservableContext } from "../../vendor-sdk-types/flue";

export const flueChannels = defineChannels("@flue/runtime", {
  createContext: channel<[unknown], FlueObservableContext>({
    channelName: "createFlueContext",
    kind: "sync-stream",
  }),
});
