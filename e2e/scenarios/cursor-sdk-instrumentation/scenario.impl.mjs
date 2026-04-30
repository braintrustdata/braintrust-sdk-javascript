import { config as loadDotEnv } from "dotenv";
import { resolve } from "node:path";
import { traced, wrapCursorSDK } from "braintrust";
import {
  collectAsync,
  runOperation,
  runTracedScenario,
} from "../../helpers/provider-runtime.mjs";

loadDotEnv({
  path: resolve(process.env.BRAINTRUST_E2E_REPO_ROOT ?? process.cwd(), ".env"),
  quiet: true,
});

const CURSOR_MODEL = "composer-2";

export const ROOT_NAME = "cursor-sdk-root";
export const SCENARIO_NAME = "cursor-sdk-instrumentation";

function cursorOptions() {
  return {
    apiKey: process.env.CURSOR_API_KEY,
    local: {
      cwd: process.cwd(),
      sandboxOptions: { enabled: false },
    },
    model: { id: CURSOR_MODEL },
  };
}

async function disposeAgent(agent) {
  if (agent?.[Symbol.asyncDispose]) {
    await agent[Symbol.asyncDispose]();
  } else if (agent?.close) {
    agent.close();
  }
}

async function runCursorSDKScenario({ decorateSDK, sdk }) {
  if (!process.env.CURSOR_API_KEY) {
    throw new Error(
      "CURSOR_API_KEY is required for cursor-sdk-instrumentation",
    );
  }

  const instrumentedSDK = decorateSDK ? decorateSDK(sdk) : sdk;
  const { Agent } = instrumentedSDK;
  let reusableAgent;

  await runTracedScenario({
    callback: async () => {
      await runOperation("cursor-sdk-prompt-operation", "prompt", async () => {
        await Agent.prompt(
          "Reply with exactly: CURSOR_PROMPT_OK. Do not modify files.",
          cursorOptions(),
        );
      });

      await runOperation("cursor-sdk-stream-operation", "stream", async () => {
        reusableAgent = await Agent.create({
          ...cursorOptions(),
          agents: {
            reviewer: {
              description: "Reads the request and replies briefly.",
              model: "inherit",
              prompt: "Reply concisely. Do not modify files.",
            },
          },
        });
        const run = await reusableAgent.send(
          "Run the shell command `printf cursor_tool_ok` and report the output. Do not edit files.",
        );
        await collectAsync(run.stream());
      });

      await runOperation("cursor-sdk-wait-operation", "wait", async () => {
        const agent = await Agent.create(cursorOptions());
        try {
          const run = await agent.send(
            "Reply with exactly: CURSOR_WAIT_OK. Do not modify files.",
            {
              onDelta: async ({ update }) => {
                await traced(async () => update.type, {
                  name: "cursor-sdk-user-on-delta",
                });
              },
              onStep: async ({ step }) => {
                await traced(async () => step.type, {
                  name: "cursor-sdk-user-on-step",
                });
              },
            },
          );
          await run.wait();
        } finally {
          await disposeAgent(agent);
        }
      });

      await runOperation(
        "cursor-sdk-resume-conversation-operation",
        "resume-conversation",
        async () => {
          const agentId = reusableAgent?.agentId;
          if (!agentId) {
            throw new Error("Expected reusable Cursor agent id");
          }
          const agent = await Agent.resume(agentId, cursorOptions());
          try {
            const run = await agent.send(
              "Reply with exactly: CURSOR_CONVERSATION_OK. Do not modify files.",
            );
            await run.conversation();
          } finally {
            await disposeAgent(agent);
          }
        },
      );
    },
    flushCount: 2,
    flushDelayMs: 250,
    metadata: {
      scenario: SCENARIO_NAME,
    },
    projectNameBase: "e2e-cursor-sdk-instrumentation",
    rootName: ROOT_NAME,
  });

  await disposeAgent(reusableAgent);
}

export async function runWrappedCursorSDKInstrumentation(sdk) {
  await runCursorSDKScenario({
    decorateSDK: wrapCursorSDK,
    sdk,
  });
}

export async function runAutoCursorSDKInstrumentation(sdk) {
  await runCursorSDKScenario({
    sdk,
  });
}
