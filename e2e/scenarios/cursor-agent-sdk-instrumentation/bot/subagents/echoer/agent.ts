import { defineAgent } from "@grok/agent-sdk";

export default defineAgent({
  description:
    "Echo subagent. Use only when the user says DELEGATE. The task description must be SUBAGENT_OK.",
});
