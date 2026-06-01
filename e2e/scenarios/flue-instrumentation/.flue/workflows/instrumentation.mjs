import { createAgent, Type } from "@flue/runtime";
import { local } from "@flue/runtime/node";
import {
  FLUE_MODEL,
  FLUE_REASONING_MODEL,
  SCENARIO_NAME,
} from "../../constants.mjs";

function flueModel() {
  return process.env.FLUE_E2E_MODEL ?? FLUE_MODEL;
}

function flueReasoningModel() {
  return process.env.FLUE_E2E_REASONING_MODEL ?? FLUE_REASONING_MODEL;
}

function fluePromptModel() {
  return process.env.FLUE_E2E_PROMPT_MODEL ?? flueReasoningModel();
}

function fluePromptThinkingLevel() {
  return (
    process.env.FLUE_E2E_PROMPT_THINKING_LEVEL ?? flueReasoningThinkingLevel()
  );
}

function flueReasoningThinkingLevel() {
  return process.env.FLUE_E2E_REASONING_THINKING_LEVEL ?? "medium";
}

const flueE2EAgent = createAgent(() => ({
  compaction: {
    keepRecentTokens: 1,
    reserveTokens: 64,
  },
  cwd: process.cwd(),
  instructions: [
    "You are a deterministic Flue instrumentation test agent.",
    "Follow user instructions exactly.",
    "When asked for a marker, output only that marker and no extra text.",
    "When running a local skill file, read it yourself and do not delegate it to a task.",
  ].join(" "),
  model: flueModel(),
  sandbox: local({ cwd: process.cwd() }),
  thinkingLevel: "off",
}));

const lookupTool = {
  description:
    "Return a deterministic lookup result with an id needed by web_search.",
  execute: async (args) =>
    JSON.stringify({
      id: "flue-session-2026",
      query: args.query,
      topic: "session instrumentation",
    }),
  name: "lookup",
  parameters: Type.Object({
    query: Type.String(),
  }),
};

const webSearchTool = {
  description:
    "Search a deterministic local web index. Requires the id returned by lookup.",
  execute: async (args) =>
    JSON.stringify({
      lookupId: args.lookupId,
      query: args.query,
      results: [
        {
          title: "Flue reasoning stream instrumentation",
          url: "https://example.test/flue/reasoning-streams",
        },
      ],
    }),
  name: "web_search",
  parameters: Type.Object({
    lookupId: Type.String(),
    query: Type.String(),
  }),
};

const summarizeSourceTool = {
  description:
    "Summarize the selected deterministic source after web_search returns a URL.",
  execute: async (args) =>
    JSON.stringify({
      summary:
        "Flue emits reasoning, tool execution, and LLM turn events separately.",
      url: args.url,
    }),
  name: "summarize_source",
  parameters: Type.Object({
    url: Type.String(),
  }),
};

export async function route(_ctx, next) {
  await next();
}

export async function run({ init, payload }) {
  const harness = await init(flueE2EAgent, { name: "default" });
  const session = await harness.session("main");
  const skillSession = await harness.session("skill");
  const taskSession = await harness.session("task");

  await session.prompt(
    [
      "Complete this instrumented research flow.",
      "Call exactly one tool per turn and wait for each tool result before choosing the next tool.",
      'Step 1: call lookup with query "flue instrumentation".',
      'Step 2: use the lookup result id as lookupId and call web_search with query "Braintrust Flue reasoning stream instrumentation".',
      "Step 3: use the first web_search result url and call summarize_source.",
      "After summarize_source returns, reply with exactly PROMPT_DONE and no other text.",
    ].join(" "),
    {
      model: fluePromptModel(),
      thinkingLevel: fluePromptThinkingLevel(),
      tools: [lookupTool, webSearchTool, summarizeSourceTool],
    },
  );

  await skillSession.skill("e2e-flue-skill", {
    args: { marker: "SKILL_DONE" },
    model: flueReasoningModel(),
    thinkingLevel: "off",
  });

  await taskSession.task("Reply with exactly TASK_DONE and no other text.", {
    model: FLUE_MODEL,
    thinkingLevel: "off",
  });

  await session.compact();

  return {
    scenario: payload?.scenario ?? SCENARIO_NAME,
    status: "done",
  };
}
