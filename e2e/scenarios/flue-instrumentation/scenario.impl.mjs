import { Type } from "@flue/runtime";
import { configureProvider } from "@flue/runtime/app";
import {
  createFlueContext,
  InMemorySessionStore,
  resolveModel,
} from "@flue/runtime/internal";
import { local } from "@flue/runtime/node";
import { wrapFlueContext } from "braintrust";
import {
  runMain,
  runOperation,
  runTracedScenario,
} from "../../helpers/provider-runtime.mjs";
import {
  FLUE_MODEL,
  FLUE_REASONING_MODEL,
  ROOT_NAME,
  SCENARIO_NAME,
} from "./constants.mjs";

const openAIBaseUrl =
  process.env.OPENAI_BASE_URL ?? process.env.BRAINTRUST_E2E_MODEL_BASE_URL;
if (openAIBaseUrl) {
  configureProvider("openai", { baseUrl: openAIBaseUrl });
}

const anthropicBaseUrl = process.env.ANTHROPIC_BASE_URL;
if (anthropicBaseUrl) {
  configureProvider("anthropic", {
    apiKey: process.env.ANTHROPIC_API_KEY ?? "test-key",
    baseUrl: anthropicBaseUrl,
  });
}

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

function makeContext() {
  const sandbox = local({ cwd: process.cwd() });
  return createFlueContext({
    agentConfig: {
      compaction: {
        keepRecentTokens: 1,
        reserveTokens: 64,
      },
      model: resolveModel(flueModel()),
      resolveModel,
      roles: {
        skillRunner: {
          description: "Runs the Flue e2e skill without delegating.",
          instructions: [
            "Never call the task tool.",
            "Do not delegate e2e-flue-skill to another session.",
            "If you need the skill body, read .agents/skills/e2e-flue-skill/SKILL.md yourself with the read tool.",
            "Return the marker from the Arguments object exactly, with no other text.",
          ].join(" "),
          name: "skillRunner",
        },
      },
      skills: {},
      systemPrompt: [
        "You are a deterministic Flue instrumentation test agent.",
        "Follow user instructions exactly.",
        "When asked for a marker, output only that marker and no extra text.",
        "When running a local skill file, read it yourself and do not delegate it to a task.",
      ].join(" "),
      thinkingLevel: "off",
    },
    createDefaultEnv: async () =>
      sandbox.createSessionEnv({
        cwd: process.cwd(),
        id: "flue-e2e-default",
      }),
    defaultStore: new InMemorySessionStore(),
    env: process.env,
    id: "flue-e2e-instance",
    payload: {
      scenario: SCENARIO_NAME,
    },
    runId: `flue-e2e-${process.env.BRAINTRUST_E2E_RUN_ID ?? "local"}`,
  });
}

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

export async function runFlueInstrumentationScenario({ wrapContext }) {
  const rawContext = makeContext();
  const ctx = wrapContext ? wrapFlueContext(rawContext) : rawContext;

  await runTracedScenario({
    callback: async () => {
      const harness = await ctx.init({
        compaction: {
          keepRecentTokens: 1,
          reserveTokens: 64,
        },
        cwd: process.cwd(),
        model: flueModel(),
        sandbox: local({ cwd: process.cwd() }),
      });
      const session = await harness.session("main");
      const skillSession = await harness.session("skill");
      const taskSession = await harness.session("task");

      await runOperation("flue-prompt-operation", "prompt", async () => {
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
            cacheRetention: "none",
            maxTokens: 2048,
            model: fluePromptModel(),
            thinkingLevel: fluePromptThinkingLevel(),
            tools: [lookupTool, webSearchTool, summarizeSourceTool],
          },
        );
      });

      await runOperation("flue-skill-operation", "skill", async () => {
        await skillSession.skill("e2e-flue-skill", {
          args: { marker: "SKILL_DONE" },
          cacheRetention: "none",
          maxTokens: 128,
          model: flueReasoningModel(),
          role: "skillRunner",
          thinkingLevel: "off",
        });
      });

      await runOperation("flue-task-operation", "task", async () => {
        await taskSession.task(
          "Reply with exactly TASK_DONE and no other text.",
          {
            cacheRetention: "none",
            maxTokens: 32,
            model: FLUE_MODEL,
            thinkingLevel: "off",
          },
        );
      });

      await runOperation("flue-compact-operation", "compact", async () => {
        await session.compact();
      });
    },
    flushCount: 2,
    flushDelayMs: 100,
    metadata: {
      scenario: SCENARIO_NAME,
    },
    projectNameBase: "e2e-flue-instrumentation",
    rootName: ROOT_NAME,
  });
}

export function runWrappedFlueInstrumentation() {
  return runFlueInstrumentationScenario({ wrapContext: true });
}

export function runAutoFlueInstrumentation() {
  return runFlueInstrumentationScenario({ wrapContext: false });
}

export { runMain };
