import { INSTRUMENTATION_NAMES } from "../../span-origin";
import { channel, defineChannels } from "../core/channel-definitions";

export const e2bChannels = defineChannels(
  "e2b",
  {
    create: channel<[templateOrOptions?: unknown, options?: unknown], unknown>({
      channelName: "Sandbox.create",
      kind: "async",
    }),
    run: channel<[command: string, options?: unknown], unknown>({
      channelName: "Commands.run",
      kind: "async",
    }),
  },
  { instrumentationName: INSTRUMENTATION_NAMES.E2B },
);

export const e2bCodeInterpreterChannels = defineChannels(
  "@e2b/code-interpreter",
  {
    runCode: channel<[code: string, options?: unknown], unknown>({
      channelName: "Sandbox.runCode",
      kind: "async",
    }),
  },
  { instrumentationName: INSTRUMENTATION_NAMES.E2B },
);
