import {
  BasePlugin,
  type ChannelMessage,
  isAsyncIterable,
  patchStreamIfNeeded,
} from "../core";
import type { IsoChannelHandlers } from "../../isomorph";
import { startSpan } from "../../logger";
import type { Span } from "../../logger";
import { SpanTypeAttribute } from "../../../util/index";
import { getCurrentUnixTimestamp } from "../../util";
import {
  extractAnthropicCacheTokens,
  finalizeAnthropicTokens,
} from "../../wrappers/anthropic-tokens-util";
import { claudeAgentSDKChannels } from "./claude-agent-sdk-channels";
import type {
  ClaudeAgentSDKMessage,
  ClaudeAgentSDKQueryOptions,
} from "../../vendor-sdk-types/claude-agent-sdk";

/**
 * Filters options to include only specific serializable fields for logging.
 */
function filterSerializableOptions(
  options: ClaudeAgentSDKQueryOptions,
): Record<string, unknown> {
  const allowedKeys = [
    "model",
    "maxTurns",
    "cwd",
    "continue",
    "allowedTools",
    "disallowedTools",
    "additionalDirectories",
    "permissionMode",
    "debug",
    "apiKey",
    "apiKeySource",
    "agentName",
    "instructions",
  ];

  const filtered: Record<string, unknown> = {};

  for (const key of allowedKeys) {
    if (options[key] !== undefined) {
      filtered[key] = options[key];
    }
  }

  return filtered;
}

/**
 * Get a number property safely from an object.
 */
function getNumberProperty(obj: unknown, key: string): number | undefined {
  if (!obj || typeof obj !== "object" || !(key in obj)) {
    return undefined;
  }
  const value = Reflect.get(obj, key);
  return typeof value === "number" ? value : undefined;
}

/**
 * Extract and normalize usage metrics from a Claude Agent SDK message.
 */
function extractUsageFromMessage(
  message: ClaudeAgentSDKMessage,
): Record<string, number> {
  const metrics: Record<string, number> = {};

  // Assistant messages contain usage in message.message.usage
  // Result messages contain usage in message.usage
  let usage: unknown;
  if (message.type === "assistant") {
    usage = message.message?.usage;
  } else if (message.type === "result") {
    usage = message.usage;
  }

  if (!usage || typeof usage !== "object") {
    return metrics;
  }

  // Standard token counts
  const inputTokens = getNumberProperty(usage, "input_tokens");
  if (inputTokens !== undefined) {
    metrics.prompt_tokens = inputTokens;
  }

  const outputTokens = getNumberProperty(usage, "output_tokens");
  if (outputTokens !== undefined) {
    metrics.completion_tokens = outputTokens;
  }

  // Anthropic cache tokens
  const cacheReadTokens =
    getNumberProperty(usage, "cache_read_input_tokens") || 0;
  const cacheCreationTokens =
    getNumberProperty(usage, "cache_creation_input_tokens") || 0;

  if (cacheReadTokens > 0 || cacheCreationTokens > 0) {
    const cacheTokens = extractAnthropicCacheTokens(
      cacheReadTokens,
      cacheCreationTokens,
    );
    Object.assign(metrics, cacheTokens);
  }

  // Finalize Anthropic token calculations
  if (Object.keys(metrics).length > 0) {
    Object.assign(metrics, finalizeAnthropicTokens(metrics));
  }

  return metrics;
}

/**
 * Builds the input array for an LLM span from the initial prompt and conversation history.
 */
function buildLLMInput(
  prompt: string | AsyncIterable<ClaudeAgentSDKMessage> | undefined,
  conversationHistory: Array<{ content: unknown; role: string }>,
): Array<{ content: unknown; role: string }> | undefined {
  const promptMessage =
    typeof prompt === "string" ? { content: prompt, role: "user" } : undefined;

  const inputParts = [
    ...(promptMessage ? [promptMessage] : []),
    ...conversationHistory,
  ];

  return inputParts.length > 0 ? inputParts : undefined;
}

/**
 * Creates an LLM span for a group of messages with the same message ID.
 * Returns the final message content to add to conversation history.
 */
async function createLLMSpanForMessages(
  messages: ClaudeAgentSDKMessage[],
  prompt: string | AsyncIterable<ClaudeAgentSDKMessage> | undefined,
  conversationHistory: Array<{ content: unknown; role: string }>,
  options: ClaudeAgentSDKQueryOptions,
  startTime: number,
  parentSpan: Awaited<ReturnType<typeof startSpan>>["export"] extends (
    ...args: infer _
  ) => Promise<infer R>
    ? R
    : never,
): Promise<{ content: unknown; role: string } | undefined> {
  if (messages.length === 0) return undefined;

  const lastMessage = messages[messages.length - 1];
  if (lastMessage.type !== "assistant" || !lastMessage.message?.usage) {
    return undefined;
  }

  const model = lastMessage.message.model || options.model;
  const usage = extractUsageFromMessage(lastMessage);
  const input = buildLLMInput(prompt, conversationHistory);
  const outputs = messages
    .map((m) =>
      m.message?.content && m.message?.role
        ? { content: m.message.content, role: m.message.role }
        : undefined,
    )
    .filter(
      (c): c is { content: NonNullable<unknown>; role: string } =>
        c !== undefined,
    );

  // Use traced pattern for LLM spans
  const span = startSpan({
    name: "anthropic.messages.create",
    spanAttributes: {
      type: SpanTypeAttribute.LLM,
    },
    startTime,
    parent: parentSpan,
  });

  span.log({
    input,
    output: outputs,
    metadata: model ? { model } : undefined,
    metrics: usage,
  });

  await span.end();

  return lastMessage.message?.content && lastMessage.message?.role
    ? { content: lastMessage.message.content, role: lastMessage.message.role }
    : undefined;
}

/**
 * Plugin for Claude Agent SDK auto-instrumentation.
 *
 * Subscribes to orchestrion:claude-agent-sdk:* channels and creates
 * Braintrust spans with proper tracing for agent interactions.
 *
 * NOTE: Uses span type TASK (not LLM) for agent interactions since agents
 * represent higher-level workflows. Individual LLM calls within the agent
 * are traced separately as LLM spans.
 */
export class ClaudeAgentSDKPlugin extends BasePlugin<
  typeof claudeAgentSDKChannels
> {
  protected onEnable(): void {
    this.subscribeToQuery();
  }

  protected onDisable(): void {
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.unsubscribers = [];
  }

  /**
   * Subscribe to the query channel for agent interactions.
   * Handles streaming responses and traces both the top-level agent task
   * and individual LLM calls.
   */
  private subscribeToQuery(): void {
    const channel = claudeAgentSDKChannels.query.tracingChannel();

    const spans = new WeakMap<
      WeakKey,
      {
        span: Span;
        startTime: number;
        conversationHistory: Array<{ content: unknown; role: string }>;
        currentMessages: ClaudeAgentSDKMessage[];
        currentMessageId: string | undefined;
        currentMessageStartTime: number;
        accumulatedOutputTokens: number;
      }
    >();

    const handlers: IsoChannelHandlers<
      ChannelMessage<typeof claudeAgentSDKChannels.query>
    > = {
      start: (event) => {
        const params = event.arguments[0];
        const prompt = params?.prompt;
        const options = params?.options ?? {};

        const span = startSpan({
          name: "Claude Agent",
          spanAttributes: {
            type: SpanTypeAttribute.TASK,
          },
        });

        const startTime = getCurrentUnixTimestamp();

        try {
          span.log({
            input:
              typeof prompt === "string"
                ? prompt
                : {
                    type: "streaming",
                    description: "AsyncIterable<ClaudeAgentSDKMessage>",
                  },
            metadata: filterSerializableOptions(options),
          });
        } catch (error) {
          console.error("Error extracting input for Claude Agent SDK:", error);
        }

        spans.set(event, {
          span,
          startTime,
          conversationHistory: [],
          currentMessages: [],
          currentMessageId: undefined,
          currentMessageStartTime: startTime,
          accumulatedOutputTokens: 0,
        });
      },

      asyncEnd: (event) => {
        const spanData = spans.get(event);
        if (!spanData) {
          return;
        }

        const eventResult = event.result;
        if (eventResult === undefined) {
          spanData.span.end();
          spans.delete(event);
          return;
        }

        // Check if result is a stream
        if (isAsyncIterable(eventResult)) {
          // Patch the stream to collect chunks and trace them
          patchStreamIfNeeded(eventResult, {
            onChunk: async (message: ClaudeAgentSDKMessage) => {
              const currentTime = getCurrentUnixTimestamp();
              const params = event.arguments[0];
              const prompt = params?.prompt;
              const options = params?.options ?? {};

              const messageId = message.message?.id;

              // When we see a new message ID, finalize the previous group
              if (messageId && messageId !== spanData.currentMessageId) {
                if (spanData.currentMessages.length > 0) {
                  const finalMessage = await createLLMSpanForMessages(
                    spanData.currentMessages,
                    prompt,
                    spanData.conversationHistory,
                    options,
                    spanData.currentMessageStartTime,
                    await spanData.span.export(),
                  );

                  if (finalMessage) {
                    spanData.conversationHistory.push(finalMessage);
                  }

                  // Track accumulated output tokens
                  const lastMessage =
                    spanData.currentMessages[
                      spanData.currentMessages.length - 1
                    ];
                  if (lastMessage?.message?.usage) {
                    const outputTokens =
                      getNumberProperty(
                        lastMessage.message.usage,
                        "output_tokens",
                      ) || 0;
                    spanData.accumulatedOutputTokens += outputTokens;
                  }

                  spanData.currentMessages = [];
                }

                spanData.currentMessageId = messageId;
                spanData.currentMessageStartTime = currentTime;
              }

              // Collect assistant messages with usage
              if (message.type === "assistant" && message.message?.usage) {
                spanData.currentMessages.push(message);
              }

              // Capture final usage metrics from result message
              if (message.type === "result" && message.usage) {
                const finalUsageMetrics = extractUsageFromMessage(message);

                // HACK: Adjust the last assistant message's output_tokens to match result total.
                // The result message contains aggregated totals, so we calculate the difference:
                // last message tokens = total result tokens - previously accumulated tokens
                // The other metrics already accumulate correctly.
                if (
                  spanData.currentMessages.length > 0 &&
                  finalUsageMetrics.completion_tokens !== undefined
                ) {
                  const lastMessage =
                    spanData.currentMessages[
                      spanData.currentMessages.length - 1
                    ];
                  if (lastMessage?.message?.usage) {
                    const adjustedTokens =
                      finalUsageMetrics.completion_tokens -
                      spanData.accumulatedOutputTokens;
                    if (adjustedTokens >= 0) {
                      lastMessage.message.usage.output_tokens = adjustedTokens;
                    }
                  }
                }

                // Log result metadata
                const result_metadata: Record<string, unknown> = {};
                if (message.num_turns !== undefined) {
                  result_metadata.num_turns = message.num_turns;
                }
                if (message.session_id !== undefined) {
                  result_metadata.session_id = message.session_id;
                }
                if (Object.keys(result_metadata).length > 0) {
                  spanData.span.log({
                    metadata: result_metadata,
                  });
                }
              }
            },
            onComplete: async () => {
              try {
                const params = event.arguments[0];
                const prompt = params?.prompt;
                const options = params?.options ?? {};

                // Create span for final message group
                if (spanData.currentMessages.length > 0) {
                  const finalMessage = await createLLMSpanForMessages(
                    spanData.currentMessages,
                    prompt,
                    spanData.conversationHistory,
                    options,
                    spanData.currentMessageStartTime,
                    await spanData.span.export(),
                  );

                  if (finalMessage) {
                    spanData.conversationHistory.push(finalMessage);
                  }
                }

                // Log final output to top-level span - just the last message content
                spanData.span.log({
                  output:
                    spanData.conversationHistory.length > 0
                      ? spanData.conversationHistory[
                          spanData.conversationHistory.length - 1
                        ]
                      : undefined,
                });
              } catch (error) {
                console.error(
                  "Error extracting output for Claude Agent SDK:",
                  error,
                );
              } finally {
                spanData.span.end();
                spans.delete(event);
              }
            },
            onError: (error: Error) => {
              spanData.span.log({
                error: error.message,
              });
              spanData.span.end();
              spans.delete(event);
            },
          });

          // Don't delete the span from the map yet - it will be ended by the stream
        } else {
          // Non-streaming response (shouldn't happen for query, but handle gracefully)
          try {
            spanData.span.log({
              output: eventResult,
            });
          } catch (error) {
            console.error(
              "Error extracting output for Claude Agent SDK:",
              error,
            );
          } finally {
            spanData.span.end();
            spans.delete(event);
          }
        }
      },

      error: (event) => {
        const spanData = spans.get(event);
        if (!spanData || !event.error) {
          return;
        }

        const { span } = spanData;

        span.log({
          error: event.error.message,
        });
        span.end();
        spans.delete(event);
      },
    };

    channel.subscribe(handlers);

    // Store unsubscribe function
    this.unsubscribers.push(() => {
      channel.unsubscribe(handlers);
    });
  }
}
