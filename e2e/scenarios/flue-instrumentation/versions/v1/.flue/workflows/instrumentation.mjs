import { defineAgent, defineTool, defineWorkflow } from "@flue/runtime";
import { local } from "@flue/runtime/node";
import { traced } from "braintrust";
import * as v from "valibot";
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

const flueE2EAgent = defineAgent(() => ({
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

const lookupTool = defineTool({
  description:
    "Return a deterministic lookup result with an id needed by web_search.",
  input: v.object({
    query: v.string(),
  }),
  name: "lookup",
  run: async ({ input }) => {
    await traced(
      async (span) => {
        span.log({ output: "lookup-active" });
      },
      {
        name: "flue.toolCurrentProbe",
        event: {
          metadata: {
            scenario: SCENARIO_NAME,
          },
        },
      },
    );

    return JSON.stringify({
      id: "flue-session-2026",
      query: input.query,
      topic: "session instrumentation",
    });
  },
});

const webSearchTool = defineTool({
  description:
    "Search a deterministic local web index. Requires the id returned by lookup.",
  input: v.object({
    lookupId: v.string(),
    query: v.string(),
  }),
  name: "web_search",
  run: async ({ input }) =>
    JSON.stringify({
      lookupId: input.lookupId,
      query: input.query,
      results: [
        {
          title: "Flue reasoning stream instrumentation",
          url: "https://example.test/flue/reasoning-streams",
        },
      ],
    }),
});

const summarizeSourceTool = defineTool({
  description:
    "Summarize the selected deterministic source after web_search returns a URL.",
  input: v.object({
    url: v.string(),
  }),
  name: "summarize_source",
  run: async ({ input }) =>
    JSON.stringify({
      summary:
        "Flue emits reasoning, tool execution, and LLM turn events separately.",
      url: input.url,
    }),
});

export async function route(_ctx, next) {
  await next();
}

export default defineWorkflow({
  agent: flueE2EAgent,
  input: v.object({
    scenario: v.optional(v.string()),
    metadata: v.optional(v.record(v.string(), v.unknown())),
  }),
  async run({ harness, input }) {
    await traced(
      async (span) => {
        span.log({ output: "active" });
      },
      {
        name: "flue.workflowCurrentProbe",
        event: {
          metadata: {
            scenario: SCENARIO_NAME,
          },
        },
      },
    );

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
      scenario: input.scenario ?? SCENARIO_NAME,
      status: "done",
    };
  },
});
