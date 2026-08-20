import { Context } from "@deepseek-ai/cordis";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import * as llmPiAi from "@deepseek-ai/dsh-llm-pi-ai";
import { SessionId } from "@deepseek-ai/dsh-session";
import { defineTool } from "@deepseek-ai/dsh-tools";
import * as braintrustPlugin from "@braintrust/deepseek-harness";
import {
  getTestRunId,
  runMain,
  scopedName,
} from "../../helpers/scenario-runtime";

async function main(): Promise<void> {
  const spinePackage =
    process.env.DEEPSEEK_HARNESS_PACKAGE ?? "deepseek-harness-v0-latest";
  const spine = await import(spinePackage);
  const ctx = new Context();

  await ctx.plugin(spine, {
    agents: [],
    goals: false,
    skills: { enabled: false },
    toolBash: false,
    toolJobs: false,
    workspaceContext: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));

  await ctx.plugin(llmPiAi, {
    providers: {
      openai: {
        apiKeyEnv: "OPENAI_API_KEY",
        baseURL: process.env.OPENAI_BASE_URL,
        models: [
          {
            id: "gpt-5.6-luna",
            contextWindow: 1_050_000,
            maxTokens: 128_000,
            reasoningEfforts: {
              off: undefined,
              low: "low",
              medium: "medium",
              high: "high",
              xhigh: "xhigh",
              max: "max",
            },
          },
        ],
      },
    },
  });
  await ctx.plugin(braintrustPlugin, {
    projectName: scopedName(
      "e2e-deepseek-harness-instrumentation",
      getTestRunId(),
    ),
    metadata: {
      scenario: "deepseek-harness-instrumentation",
      testRunId: getTestRunId(),
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 25));

  ctx.tools.register(
    defineTool({
      name: "lookup",
      description: "Return a deterministic lookup result",
      parameters: { query: { type: "string", required: true } },
      output: {
        schema: { type: "string" },
        render: (_args, value) => [{ type: "text", text: value }],
      },
      async execute(args) {
        return `Lookup result for ${args.query}`;
      },
    }),
  );

  const handle = await ctx.agents.create({
    sessionId: SessionId("deepseek-harness-e2e-session"),
    meta: { cwd: process.cwd() },
    agentOptions: {
      provider: "openai",
      model: "gpt-5.6-luna",
      maxTokens: 2_000,
    },
  });

  for (const prompt of [
    "Call lookup exactly once with query `first`. Then reply exactly: First Harness answer.",
    "Call lookup exactly once with query `second`. Then reply exactly: Second Harness answer.",
  ]) {
    handle.agent.followup(
      createUserMessage({
        content: [{ type: "text", text: prompt }],
        source: { kind: "user" },
      }),
    );
    await handle.agent.whenIdle();
  }

  await handle.dispose();
  await ctx.fiber.dispose();
}

runMain(main);
