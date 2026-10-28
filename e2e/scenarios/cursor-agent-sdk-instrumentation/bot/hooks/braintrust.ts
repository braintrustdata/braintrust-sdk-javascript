import { defineHook } from "@grok/agent-sdk/hooks";
import { cursorAgentSDKHookEvents } from "braintrust";

export default defineHook({
  events: cursorAgentSDKHookEvents(),
});
