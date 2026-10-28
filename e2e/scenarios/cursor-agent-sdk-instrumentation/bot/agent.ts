import { defineAgent } from "@grok/agent-sdk";

const workspace = process.env.CURSOR_AGENT_WORKSPACE;

export default defineAgent({
  model: "composer-2.5",
  concurrency: { maxRunningTurns: 4 },
  tools: ["task"],
  ...(workspace ? { local: { cwd: workspace } } : {}),
});
