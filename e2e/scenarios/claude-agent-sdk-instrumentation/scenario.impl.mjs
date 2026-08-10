import { readFile } from "node:fs/promises";
import { startSpan, traced, wrapClaudeAgentSDK } from "braintrust";
import {
  collectAsync,
  runOperation,
  runTracedScenario,
} from "../../helpers/provider-runtime.mjs";
import { z } from "zod";

const CLAUDE_AGENT_MODEL = "claude-haiku-4-5";
const CLAUDE_AGENT_TOP_LEVEL_MODEL = "claude-sonnet-4-5";

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

function collectFinalPartialUsage(messages) {
  const activeMessageByParent = new Map();
  const usageByMessageId = new Map();

  for (const message of messages) {
    if (message.type !== "stream_event") {
      continue;
    }

    const parentKey = message.parent_tool_use_id ?? "__root__";
    const event = message.event;
    if (event?.type === "message_start" && event.message?.id) {
      activeMessageByParent.set(parentKey, event.message.id);
      usageByMessageId.set(event.message.id, {
        message_id: event.message.id,
        parent_tool_use_id: message.parent_tool_use_id ?? null,
        usage: { ...event.message.usage },
      });
      continue;
    }

    const messageId = activeMessageByParent.get(parentKey);
    if (!messageId) {
      continue;
    }

    if (event?.type === "message_delta") {
      const captured = usageByMessageId.get(messageId);
      if (captured && event.usage) {
        Object.assign(captured.usage, event.usage);
      }
    } else if (event?.type === "message_stop") {
      activeMessageByParent.delete(parentKey);
    }
  }

  return [...usageByMessageId.values()];
}

function assertNoPartialMessages(messages) {
  if (messages.some((message) => message.type === "stream_event")) {
    throw new Error(
      "Braintrust exposed internally enabled Claude Agent SDK partial messages",
    );
  }
}

function createTranscriptCapture() {
  const state = {
    rootPath: undefined,
    subagentPathByToolUseId: new Map(),
  };

  const captureRootTranscriptPath = async (input) => {
    if (
      (input.hook_event_name === "SessionStart" ||
        input.hook_event_name === "SessionEnd" ||
        input.hook_event_name === "UserPromptSubmit") &&
      typeof input.transcript_path === "string"
    ) {
      state.rootPath = input.transcript_path;
    }
    return {};
  };

  return {
    hooks: {
      SessionStart: [{ hooks: [captureRootTranscriptPath] }],
      SessionEnd: [{ hooks: [captureRootTranscriptPath] }],
      UserPromptSubmit: [{ hooks: [captureRootTranscriptPath] }],
      SubagentStop: [
        {
          hooks: [
            async (input, toolUseId) => {
              if (
                input.hook_event_name === "SubagentStop" &&
                typeof toolUseId === "string" &&
                typeof input.agent_transcript_path === "string"
              ) {
                state.subagentPathByToolUseId.set(
                  toolUseId,
                  input.agent_transcript_path,
                );
              }
              return {};
            },
          ],
        },
      ],
    },
    state,
  };
}

function validTokenCount(value) {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
    ? value
    : undefined;
}

async function readFinalTranscriptUsage(transcriptPath, parentToolUseId) {
  const text = await readFile(transcriptPath, "utf8");
  const usageByMessageId = new Map();

  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }

    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }

    const messageId = row?.type === "assistant" ? row.message?.id : undefined;
    const usage = row?.message?.usage;
    if (typeof messageId !== "string" || !usage) {
      continue;
    }

    const inputTokens = validTokenCount(usage.input_tokens);
    const outputTokens = validTokenCount(usage.output_tokens);
    const cacheReadTokens = validTokenCount(usage.cache_read_input_tokens ?? 0);
    const cacheCreationTokens = validTokenCount(
      usage.cache_creation_input_tokens ?? 0,
    );
    let cacheCreation;
    if (usage.cache_creation !== undefined) {
      if (!usage.cache_creation || typeof usage.cache_creation !== "object") {
        continue;
      }

      const cacheCreation5mTokens = validTokenCount(
        usage.cache_creation.ephemeral_5m_input_tokens,
      );
      const cacheCreation1hTokens = validTokenCount(
        usage.cache_creation.ephemeral_1h_input_tokens,
      );
      if (
        (usage.cache_creation.ephemeral_5m_input_tokens !== undefined &&
          cacheCreation5mTokens === undefined) ||
        (usage.cache_creation.ephemeral_1h_input_tokens !== undefined &&
          cacheCreation1hTokens === undefined)
      ) {
        continue;
      }
      if (
        cacheCreation5mTokens !== undefined ||
        cacheCreation1hTokens !== undefined
      ) {
        cacheCreation = {
          ...(cacheCreation5mTokens !== undefined && {
            ephemeral_5m_input_tokens: cacheCreation5mTokens,
          }),
          ...(cacheCreation1hTokens !== undefined && {
            ephemeral_1h_input_tokens: cacheCreation1hTokens,
          }),
        };
      }
    }
    if (
      inputTokens === undefined ||
      outputTokens === undefined ||
      cacheReadTokens === undefined ||
      cacheCreationTokens === undefined
    ) {
      continue;
    }

    usageByMessageId.set(messageId, {
      message_id: messageId,
      parent_tool_use_id: parentToolUseId,
      usage: {
        cache_creation_input_tokens: cacheCreationTokens,
        cache_read_input_tokens: cacheReadTokens,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        ...(cacheCreation && { cache_creation: cacheCreation }),
      },
    });
  }

  return [...usageByMessageId.values()];
}

async function collectCapturedTranscriptUsage(capture, messages) {
  if (!capture.state.rootPath) {
    throw new Error("User session hook did not receive a transcript path");
  }

  const parentToolUseIdByMessageId = new Map(
    messages
      .filter(
        (message) =>
          message.type === "assistant" &&
          typeof message.message?.id === "string",
      )
      .map((message) => [
        message.message.id,
        message.parent_tool_use_id ?? null,
      ]),
  );
  const usage = await readFinalTranscriptUsage(capture.state.rootPath, null);
  for (const transcriptPath of capture.state.subagentPathByToolUseId.values()) {
    const subagentUsage = await readFinalTranscriptUsage(transcriptPath, null);
    for (const entry of subagentUsage) {
      if (parentToolUseIdByMessageId.has(entry.message_id)) {
        entry.parent_tool_use_id = parentToolUseIdByMessageId.get(
          entry.message_id,
        );
        usage.push(entry);
      }
    }
  }
  return usage;
}

async function logExpectedTranscriptUsage(name, capture, messages) {
  const expectedUsageSpan = startSpan({ name });
  expectedUsageSpan.log({
    output: await collectCapturedTranscriptUsage(capture, messages),
  });
  expectedUsageSpan.end();
}

async function collectAsyncAndAssertMessagesUnchanged(records) {
  const messages = [];
  const originalMessages = [];
  for await (const message of records) {
    messages.push(message);
    originalMessages.push(JSON.stringify(message));
  }

  for (const [index, message] of messages.entries()) {
    if (JSON.stringify(message) !== originalMessages[index]) {
      throw new Error("Braintrust mutated a Claude Agent SDK message");
    }
  }

  return messages;
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
      const result = await traced(
        async () => {
          switch (args.operation) {
            case "add":
              return args.a + args.b;
            case "subtract":
              return args.a - args.b;
            case "multiply":
              return args.a * args.b;
            case "divide":
              if (args.b === 0) {
                throw new Error("division by zero");
              }
              return args.a / args.b;
            default:
              throw new Error(`unsupported operation: ${args.operation}`);
          }
        },
        {
          name: `calculator-local-handler-${args.operation}`,
        },
      );

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
        const messages = await collectAsyncAndAssertMessagesUnchanged(
          query({
            prompt:
              "Use the calculator tool to multiply 15 by 7. Do not answer from memory.",
            options: {
              includePartialMessages: true,
              mcpServers: {
                calculator: calculatorServer,
              },
              model: CLAUDE_AGENT_MODEL,
              permissionMode: "bypassPermissions",
            },
          }),
        );
        const expectedUsageSpan = startSpan({
          name: "claude-agent-basic-partial-usage",
        });
        expectedUsageSpan.log({
          output: collectFinalPartialUsage(messages),
        });
        expectedUsageSpan.end();
      });

      await runOperation(
        "claude-agent-async-prompt-operation",
        "async-prompt",
        async () => {
          const transcriptCapture = createTranscriptCapture();
          const messages = await collectAsyncAndAssertMessagesUnchanged(
            query({
              prompt: (async function* () {
                yield makePromptMessage("Part 1");
                yield makePromptMessage("Part 2");
              })(),
              options: {
                hooks: transcriptCapture.hooks,
                includePartialMessages: false,
                maxTurns: 1,
                model: CLAUDE_AGENT_MODEL,
                permissionMode: "bypassPermissions",
              },
            }),
          );
          assertNoPartialMessages(messages);
          await logExpectedTranscriptUsage(
            "claude-agent-async-prompt-transcript-usage",
            transcriptCapture,
            messages,
          );
        },
      );

      await runOperation(
        "claude-agent-subagent-operation",
        "subagent",
        async () => {
          const transcriptCapture = createTranscriptCapture();
          const messages = await collectAsyncAndAssertMessagesUnchanged(
            query({
              prompt:
                "Spawn a math-expert subagent to add 15 and 27 using the calculator tool. Report the result. Do not solve it yourself.",
              options: {
                agents: {
                  "math-expert": {
                    description: "Math specialist",
                    model: CLAUDE_AGENT_MODEL,
                    prompt:
                      "You are a math expert. Use the calculator tool for calculations. Be concise.",
                  },
                },
                allowedTools: ["Task"],
                hooks: transcriptCapture.hooks,
                mcpServers: {
                  calculator: calculatorServer,
                },
                model: CLAUDE_AGENT_MODEL,
                permissionMode: "bypassPermissions",
              },
            }),
          );
          assertNoPartialMessages(messages);
          await logExpectedTranscriptUsage(
            "claude-agent-subagent-transcript-usage",
            transcriptCapture,
            messages,
          );
        },
      );

      await runOperation(
        "claude-agent-subagent-built-in-tool-operation",
        "subagent-built-in-tool",
        async () => {
          await collectAsync(
            query({
              prompt:
                'You MUST call the Agent tool now with subagent_type="echo" and description "echo greeting". Do not call Bash yourself. Do not answer with text yourself; delegate to the echo sub-agent.',
              options: {
                agents: {
                  echo: {
                    description: "Runs one bash echo and reports back.",
                    model: CLAUDE_AGENT_MODEL,
                    prompt:
                      "Run `echo hello` via Bash exactly once, then reply with only the word done.",
                    tools: ["Bash"],
                  },
                },
                allowedTools: ["Agent", "Bash"],
                model: CLAUDE_AGENT_TOP_LEVEL_MODEL,
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
          const messages = await collectAsyncAndAssertMessagesUnchanged(
            query({
              prompt:
                "Use the calculator tool to divide 2 by 0. Do not recover from the error.",
              options: {
                mcpServers: {
                  calculator: calculatorServer,
                },
                model: CLAUDE_AGENT_MODEL,
                permissionMode: "bypassPermissions",
                persistSession: false,
              },
            }),
          );
          assertNoPartialMessages(messages);
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
