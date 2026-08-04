import { BasePlugin, toLoggedError } from "../core";
import {
  traceAsyncChannel,
  traceStreamingChannel,
  unsubscribeAll,
} from "../core/channel-tracing";
import type { ChannelMessage } from "../core/channel-definitions";
import type { IsoChannelHandlers, IsoTracingChannel } from "../../isomorph";
import { debugLogger } from "../../debug-logger";
import { SpanTypeAttribute, isObject, isPromiseLike } from "../../../util";
import { zodToJsonSchema } from "../../zod/utils";
import { stagehandChannels } from "./stagehand-channels";
import { instrumentStagehandAgent } from "./stagehand-agent";

export class StagehandPlugin extends BasePlugin {
  protected onEnable(): void {
    this.unsubscribers.push(
      traceAsyncChannel(stagehandChannels.act, {
        name: "stagehand.act",
        type: SpanTypeAttribute.TASK,
        extractInput: (args, event) => ({
          input: extractActInput(args),
          metadata: extractCallMetadata(args, event.self),
        }),
        extractOutput: extractActionSummary,
        extractMetadata: extractResultCacheMetadata,
        extractMetrics: () => ({}),
      }),
      traceAsyncChannel(stagehandChannels.extract, {
        name: "stagehand.extract",
        type: SpanTypeAttribute.TASK,
        extractInput: (args, event) => ({
          input: extractExtractInput(args),
          metadata: extractCallMetadata(args, event.self),
        }),
        extractOutput: (result, event) =>
          extractStructuredResult(result, event?.arguments ?? []),
        extractMetadata: extractResultCacheMetadata,
        extractMetrics: () => ({}),
      }),
      traceAsyncChannel(stagehandChannels.observe, {
        name: "stagehand.observe",
        type: SpanTypeAttribute.TASK,
        extractInput: (args, event) => ({
          input: extractInstructionInput(args),
          metadata: extractCallMetadata(args, event.self),
        }),
        extractOutput: extractActionSummary,
        extractMetadata: extractResultCacheMetadata,
        extractMetrics: () => ({}),
      }),
      traceStreamingChannel(stagehandChannels.agentExecute, {
        name: "stagehand.agent.execute",
        type: SpanTypeAttribute.TASK,
        extractInput: (args, event) => ({
          input: extractAgentInput(args),
          metadata: extractAgentMetadata(event.agentConfig, event.stagehand),
        }),
        extractOutput: extractAgentOutput,
        extractMetadata: extractAgentResultMetadata,
        extractMetrics: extractAgentMetrics,
        patchResult: ({ result, span }) => {
          let finalResult: unknown;
          try {
            if (!isObject(result)) {
              return false;
            }
            finalResult = Reflect.get(result, "result");
            if (!isPromiseLike(finalResult)) {
              return false;
            }
          } catch (error) {
            debugLogger.error(
              "Error inspecting streaming Stagehand agent result:",
              error,
            );
            return false;
          }

          void Promise.resolve(finalResult)
            .then(
              (finalResult) => {
                try {
                  span.log({
                    output: extractAgentOutput(finalResult),
                    metadata: extractAgentResultMetadata(finalResult),
                    metrics: extractAgentMetrics(finalResult),
                  });
                } catch (error) {
                  debugLogger.error(
                    "Error extracting streaming Stagehand agent result:",
                    error,
                  );
                } finally {
                  span.end();
                }
              },
              (error) => {
                try {
                  span.log({
                    error:
                      error instanceof Error ? error : toLoggedError(error),
                  });
                } finally {
                  span.end();
                }
              },
            )
            .catch((error) => {
              debugLogger.error(
                "Error finalizing streaming Stagehand agent span:",
                error,
              );
            });
          return true;
        },
      }),
    );

    const tracingChannel =
      stagehandChannels.agent.tracingChannel() as IsoTracingChannel<
        ChannelMessage<typeof stagehandChannels.agent>
      >;
    const handlers: IsoChannelHandlers<
      ChannelMessage<typeof stagehandChannels.agent>
    > = {
      end: (event) => {
        instrumentStagehandAgent(event.result, event.arguments[0], event.self);
      },
    };
    tracingChannel.subscribe(handlers);
    this.unsubscribers.push(() => tracingChannel.unsubscribe(handlers));
  }

  protected onDisable(): void {
    this.unsubscribers = unsubscribeAll(this.unsubscribers);
  }
}

export function extractActInput(args: unknown[]): unknown {
  const first = args[0];
  if (typeof first === "string") {
    return { instruction: first };
  }
  if (!isObject(first)) {
    return undefined;
  }
  if (typeof first.method === "string" && "selector" in first) {
    return { action: { method: first.method } };
  }
  return undefined;
}

export function extractInstructionInput(args: unknown[]): unknown {
  const first = args[0];
  if (typeof first === "string") {
    return { instruction: first };
  }
  return undefined;
}

export function extractExtractInput(args: unknown[]): unknown {
  const input = extractInstructionInput(args);
  if (!input) {
    return undefined;
  }

  const schema = extractJsonSchema(args[1]);
  return schema ? { ...input, schema } : input;
}

export function extractActionSummary(result: unknown): unknown {
  const actions = Array.isArray(result)
    ? result
    : isObject(result) && Array.isArray(result.actions)
      ? result.actions
      : [];
  const methods = actions.flatMap((action) =>
    isObject(action) && typeof action.method === "string"
      ? [action.method]
      : [],
  );
  const output: Record<string, unknown> = {
    action_count: actions.length,
    methods,
  };
  if (isObject(result) && typeof result.success === "boolean") {
    output.success = result.success;
  }
  return output;
}

export function extractStructuredResult(
  result: unknown,
  args: readonly unknown[],
): unknown {
  if (!hasExtractInstruction(args)) {
    return undefined;
  }
  if (Array.isArray(result) || !isObject(result)) {
    return result;
  }
  return Object.fromEntries(
    Object.entries(result).filter(([key]) => key !== "cacheStatus"),
  );
}

export function extractAgentInput(args: unknown[]): unknown {
  const first = args[0];
  const options = isObject(first) ? first : isObject(args[1]) ? args[1] : {};
  const instruction =
    typeof first === "string"
      ? first
      : typeof options.instruction === "string"
        ? options.instruction
        : undefined;
  const outputSchema = extractJsonSchema(options.output);
  if (instruction === undefined && outputSchema === undefined) {
    return undefined;
  }
  return {
    ...(instruction !== undefined ? { instruction } : {}),
    ...(outputSchema !== undefined ? { output_schema: outputSchema } : {}),
  };
}

export function extractAgentOutput(result: unknown): unknown {
  if (!isObject(result)) {
    return undefined;
  }
  const output: Record<string, unknown> = {};
  if (typeof result.success === "boolean") output.success = result.success;
  if (typeof result.completed === "boolean")
    output.completed = result.completed;
  if (typeof result.message === "string") output.message = result.message;
  if (Object.prototype.hasOwnProperty.call(result, "output")) {
    output.output = result.output;
  }
  if (Array.isArray(result.actions)) {
    output.actions = result.actions.map((action) => {
      if (!isObject(action)) return {};
      const type = typeof action.type === "string" ? action.type : undefined;
      const taskCompleted =
        typeof action.taskCompleted === "boolean"
          ? action.taskCompleted
          : undefined;
      const timeMs =
        typeof action.timeMs === "number" ? action.timeMs : undefined;
      return {
        ...(type !== undefined ? { type } : {}),
        ...(taskCompleted !== undefined
          ? { task_completed: taskCompleted }
          : {}),
        ...(timeMs !== undefined ? { time_ms: timeMs } : {}),
      };
    });
  }
  return output;
}

export function extractAgentMetrics(result: unknown): Record<string, number> {
  const metrics: Record<string, number> = {};
  const usage = isObject(result) && isObject(result.usage) ? result.usage : {};
  const promptTokens = finiteNumber(usage.input_tokens);
  const completionTokens = finiteNumber(usage.output_tokens);
  const reasoningTokens = finiteNumber(usage.reasoning_tokens);
  const cachedTokens = finiteNumber(usage.cached_input_tokens);
  if (promptTokens !== undefined) metrics.prompt_tokens = promptTokens;
  if (completionTokens !== undefined) {
    metrics.completion_tokens = completionTokens;
  }
  if (promptTokens !== undefined || completionTokens !== undefined) {
    metrics.tokens = (promptTokens ?? 0) + (completionTokens ?? 0);
  }
  if (reasoningTokens !== undefined) {
    metrics.completion_reasoning_tokens = reasoningTokens;
  }
  if (cachedTokens !== undefined) {
    metrics.prompt_cached_tokens = cachedTokens;
  }
  return metrics;
}

function extractCallMetadata(
  args: readonly unknown[],
  stagehand: unknown,
): Record<string, unknown> | undefined {
  let model: string | undefined;
  for (const arg of args) {
    if (isObject(arg)) {
      model = extractModel(arg.model);
      if (model) break;
    }
  }
  model ??= extractStagehandModel(stagehand);
  return model ? { model } : undefined;
}

function extractAgentMetadata(
  config: unknown,
  stagehand: unknown,
): Record<string, unknown> | undefined {
  const agentConfig = isObject(config) ? config : {};
  const metadata: Record<string, unknown> = {};
  const model =
    extractModel(agentConfig.model) ?? extractStagehandModel(stagehand);
  if (model) metadata.model = model;
  if (typeof agentConfig.mode === "string") {
    metadata["stagehand.mode"] = agentConfig.mode;
  }
  const maxSteps = finiteNumber(agentConfig.maxSteps);
  if (maxSteps !== undefined) metadata["stagehand.max_steps"] = maxSteps;
  if (typeof agentConfig.stream === "boolean") {
    metadata["stagehand.streaming"] = agentConfig.stream;
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function extractResultCacheMetadata(
  result: unknown,
): Record<string, unknown> | undefined {
  const cacheStatus = Array.isArray(result)
    ? normalizeCacheStatus(
        Object.getOwnPropertyDescriptor(result, "cacheStatus")?.value,
      )
    : isObject(result)
      ? normalizeCacheStatus(result.cacheStatus)
      : undefined;
  return cacheStatus ? { "stagehand.cache_status": cacheStatus } : undefined;
}

function extractAgentResultMetadata(
  result: unknown,
): Record<string, unknown> | undefined {
  const metadata =
    isObject(result) && isObject(result.metadata) ? result.metadata : undefined;
  const cacheStatus = normalizeCacheStatus(metadata?.cacheHit);
  return cacheStatus ? { "stagehand.cache_status": cacheStatus } : undefined;
}

function extractStagehandModel(stagehand: unknown): string | undefined {
  if (!isObject(stagehand)) return undefined;
  const llmClient = isObject(stagehand.llmClient)
    ? stagehand.llmClient
    : undefined;
  return extractModel(llmClient?.modelName);
}

function extractModel(model: unknown): string | undefined {
  if (typeof model === "string") return model;
  return isObject(model) && typeof model.modelName === "string"
    ? model.modelName
    : undefined;
}

function normalizeCacheStatus(value: unknown): "hit" | "miss" | undefined {
  if (value === true) return "hit";
  if (value === false) return "miss";
  if (typeof value !== "string") return undefined;
  const normalized = value.toLowerCase();
  return normalized === "hit" || normalized === "miss" ? normalized : undefined;
}

function hasExtractInstruction(args: readonly unknown[]): boolean {
  return typeof args[0] === "string";
}

function isZodSchema(value: unknown): boolean {
  return isObject(value) && ("_def" in value || "_zod" in value);
}

function extractJsonSchema(value: unknown): unknown {
  if (!isZodSchema(value)) return undefined;
  try {
    return zodToJsonSchema(value as never);
  } catch (error) {
    debugLogger.error("Error converting Stagehand output schema:", error);
    return undefined;
  }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
