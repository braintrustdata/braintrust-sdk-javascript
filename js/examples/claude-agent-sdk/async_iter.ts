/**
 * Claude Agent SDK Example - Async Iterable Prompts
 *
 * Demonstrates using an async iterable as the prompt to seed a conversation
 * with multiple user turns. This pattern is useful for:
 * - Multi-turn conversations where you want to inject user context
 * - Resuming from a saved list of user prompts
 * - Programmatically building user message history
 *
 * Note: The SDK prompt AsyncIterable must contain `type: "user"` messages.
 *
 * Run: make run-async-iter
 */

import * as claudeSDK from "@anthropic-ai/claude-agent-sdk";
import { wrapClaudeAgentSDK, initLogger, traced } from "braintrust";

// Initialize Braintrust logger
initLogger({
  projectName: "Claude Agent SDK Example",
  apiKey: process.env.BRAINTRUST_API_KEY,
});

// Wrap the Claude Agent SDK for automatic tracing
const { query } = wrapClaudeAgentSDK(claudeSDK);

// Type for SDK messages
type SDKMessage = {
  type: string;
  message?: {
    role: string;
    content: Array<{ type: string; text?: string }>;
  };
  [key: string]: unknown;
};

/**
 * Creates an async iterable from an array of user messages.
 * This simulates loading a previous conversation from storage.
 */
async function* messagesFromHistory(
  messages: SDKMessage[],
): AsyncIterable<SDKMessage> {
  for (const msg of messages) {
    yield msg;
  }
}

async function main() {
  console.log(
    "Starting Claude Agent SDK example with async iterable prompt...\n",
  );
  console.log("This example demonstrates:");
  console.log("  - Using an async iterable as the prompt");
  console.log("  - Resuming a conversation with injected history");
  console.log("  - Multi-turn interactions with context\n");

  // Simulate previous user turns we want to continue from.
  // NOTE: Claude Agent SDK expects user messages only in the prompt iterable.
  const previousConversation: SDKMessage[] = [
    {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: "I'm working on a project called 'WeatherApp'. Remember this name.",
          },
        ],
      },
    },
    {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: "What was the project name I mentioned?",
          },
        ],
      },
    },
  ];

  console.log("--- Previous user messages (injected via async iterable) ---");
  for (const msg of previousConversation) {
    if (msg.message?.content?.[0]?.text) {
      const role = msg.message.role.toUpperCase();
      console.log(`${role}: ${msg.message.content[0].text}`);
    }
  }
  console.log("--- End of previous conversation ---\n");

  console.log(
    "Now querying with this history as an async iterable prompt...\n",
  );

  await traced(
    async (span) => {
      // Create an async iterable from the conversation history
      const conversationPrompt = messagesFromHistory(previousConversation);

      for await (const message of query({
        prompt: conversationPrompt,
        options: {
          model: "claude-haiku-4-5",
          permissionMode: "bypassPermissions",
          maxTurns: 1,
        },
      })) {
        if (message.type === "assistant") {
          const content = message.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text") {
                console.log(`Claude: ${block.text}`);
              }
            }
          }
        } else if (message.type === "result") {
          console.log("\n--- Result ---");
          console.log(`Turns: ${message.num_turns}`);
          console.log(`Input tokens: ${message.usage?.input_tokens}`);
          console.log(`Output tokens: ${message.usage?.output_tokens}`);
        }
      }

      console.log(`\nView trace: ${await span.link()}`);
    },
    { name: "Claude Agent SDK - Async Iterable Example" },
  );
}

main().catch(console.error);
