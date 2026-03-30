import { wrapClaudeAgentSDK } from "braintrust";
import {
  collectAsync,
  runOperation,
  runTracedScenario,
} from "../../helpers/provider-runtime.mjs";
import { z } from "zod";

const CLAUDE_AGENT_MODEL = "claude-haiku-4-5-20251001";

export const ROOT_NAME = "claude-agent-sdk-root";
export const SCENARIO_NAME = "claude-agent-sdk-traces";

function makePromptMessage(content) {
  return {
    type: "user",
    message: {
      content,
      role: "user",
    },
  };
}

async function runClaudeAgentSDKScenario({ decorateSDK, sdk }) {
  const instrumentedSDK = decorateSDK ? decorateSDK(sdk) : sdk;
  const { createSdkMcpServer, query, tool } = instrumentedSDK;
  const calculator = tool(
    "calculator",
    "Performs basic arithmetic operations",
    {
      operation: z.enum(["add", "divide", "multiply", "subtract"]),
      a: z.number(),
      b: z.number(),
    },
    async (args) => {
      let result;

      switch (args.operation) {
        case "add":
          result = args.a + args.b;
          break;
        case "subtract":
          result = args.a - args.b;
          break;
        case "multiply":
          result = args.a * args.b;
          break;
        case "divide":
          if (args.b === 0) {
            throw new Error("division by zero");
          }
          result = args.a / args.b;
          break;
        default:
          throw new Error(`unsupported operation: ${args.operation}`);
      }

      return {
        content: [
          {
            text: `${args.operation}(${args.a}, ${args.b}) = ${result}`,
            type: "text",
          },
        ],
      };
    },
  );
  const calculatorServer = createSdkMcpServer({
    name: "calculator",
    tools: [calculator],
    version: "1.0.0",
  });

  await runTracedScenario({
    callback: async () => {
      await runOperation("claude-agent-basic-operation", "basic", async () => {
        await collectAsync(
          query({
            prompt:
              "Use the calculator tool to multiply 15 by 7. Do not answer from memory.",
            options: {
              mcpServers: {
                calculator: calculatorServer,
              },
              model: CLAUDE_AGENT_MODEL,
              permissionMode: "bypassPermissions",
            },
          }),
        );
      });

      await runOperation(
        "claude-agent-async-prompt-operation",
        "async-prompt",
        async () => {
          await collectAsync(
            query({
              prompt: (async function* () {
                yield makePromptMessage("Part 1");
                yield makePromptMessage("Part 2");
              })(),
              options: {
                maxTurns: 1,
                model: CLAUDE_AGENT_MODEL,
                permissionMode: "bypassPermissions",
              },
            }),
          );
        },
      );

      await runOperation(
        "claude-agent-subagent-operation",
        "subagent",
        async () => {
          await collectAsync(
            query({
              prompt:
                "Spawn a math-expert subagent to add 15 and 27 using the calculator tool. Report the result. Do not solve it yourself.",
              options: {
                agents: {
                  "math-expert": {
                    description: "Math specialist",
                    model: "haiku",
                    prompt:
                      "You are a math expert. Use the calculator tool for calculations. Be concise.",
                  },
                },
                allowedTools: ["Task"],
                mcpServers: {
                  calculator: calculatorServer,
                },
                model: CLAUDE_AGENT_MODEL,
                permissionMode: "bypassPermissions",
              },
            }),
          );
        },
      );

      await runOperation(
        "claude-agent-failure-operation",
        "failure",
        async () => {
          await collectAsync(
            query({
              prompt:
                "Use the calculator tool to divide 2 by 0. Do not recover from the error.",
              options: {
                mcpServers: {
                  calculator: calculatorServer,
                },
                model: CLAUDE_AGENT_MODEL,
                permissionMode: "bypassPermissions",
              },
            }),
          );
        },
      );
    },
    metadata: {
      scenario: SCENARIO_NAME,
    },
    projectNameBase: "e2e-claude-agent-sdk-instrumentation",
    rootName: ROOT_NAME,
  });
}

export async function runWrappedClaudeAgentSDKInstrumentation(sdk) {
  await runClaudeAgentSDKScenario({
    decorateSDK: wrapClaudeAgentSDK,
    sdk,
  });
}

export async function runAutoClaudeAgentSDKInstrumentation(sdk) {
  await runClaudeAgentSDKScenario({
    sdk,
  });
}
