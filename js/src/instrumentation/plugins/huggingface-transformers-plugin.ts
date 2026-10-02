import { INSTRUMENTATION_NAMES } from "../../span-origin";
import { BasePlugin } from "../core";
import { traceAsyncCall, unsubscribeAll } from "../core/channel-tracing";
import { observeResult } from "../core/observe-result";

import { SpanTypeAttribute, isObject } from "../../../util";
import type { HuggingFaceTransformersPipeline } from "../../vendor-sdk-types/huggingface-transformers";
import type { ChannelMessage } from "../core/tracing-types";
import {
  getHuggingFaceTransformersPipelineInfo,
  huggingFaceTransformersChannels,
  isSupportedHuggingFaceTransformersTask,
  registerHuggingFaceTransformersPipeline,
  type HuggingFaceTransformersEventContext,
} from "./huggingface-transformers-channels";

const REQUEST_METADATA_KEYS = [
  "temperature",
  "top_p",
  "max_tokens",
  "stop",
] as const;

export class HuggingFaceTransformersPlugin extends BasePlugin {
  protected onEnable(): void {
    this.subscribeToPipelineFactory();
    this.unsubscribers.push(
      huggingFaceTransformersChannels.pipelineCall.intercept(
        (target, receiver, args, additional) =>
          traceAsyncCall<typeof huggingFaceTransformersChannels.pipelineCall>(
            () => Reflect.apply(target, receiver, args),
            { ...additional, arguments: args, self: receiver },
            {
              instrumentationName: INSTRUMENTATION_NAMES.HUGGINGFACE,
              name: (_args, event) => {
                const task = getTask(
                  event as HuggingFaceTransformersEventContext,
                );
                const operation = task?.replaceAll("-", "_") ?? "unknown";
                return `huggingface.transformers.${operation}`;
              },
              type: SpanTypeAttribute.LLM,
              shouldTrace: (_args, event) =>
                isSupportedHuggingFaceTransformersTask(
                  getTask(event as HuggingFaceTransformersEventContext),
                ),
              extractInput: (args, event) => ({
                input: extractInput(
                  getTask(event as HuggingFaceTransformersEventContext),
                  args,
                ),
                metadata: extractMetadata(
                  event as HuggingFaceTransformersEventContext,
                  args,
                ),
              }),
              extractOutput: (result, event) =>
                extractOutput(
                  getTask(event as HuggingFaceTransformersEventContext),
                  result,
                ),
              extractMetrics: () => ({}),
            },
          ),
      ),
    );
  }

  protected onDisable(): void {
    this.unsubscribers = unsubscribeAll(this.unsubscribers);
  }

  private subscribeToPipelineFactory(): void {
    const channel = huggingFaceTransformersChannels.pipeline;

    const removeHandlers = channel.intercept(
      (target, receiver, args, additional) => {
        const event = {
          ...additional,
          arguments: args,
          self: receiver,
        } as ChannelMessage<typeof huggingFaceTransformersChannels.pipeline>;
        const resolved = (
          event: ChannelMessage<
            typeof huggingFaceTransformersChannels.pipeline
          >,
        ) => {
          if (typeof event.result !== "function") {
            return;
          }
          registerHuggingFaceTransformersPipeline(
            event.result,
            event.arguments?.[0],
            event.arguments?.[1],
          );
        };
        let result;
        try {
          result = Reflect.apply(target, receiver, args);
        } catch (error) {
          throw error;
        }
        return observeResult(
          result,
          (value) => {
            Object.assign(event, { result: value });
            resolved(event);
          },
          (error) => {},
        );
      },
    );
    this.unsubscribers.push(removeHandlers);
  }
}

function getTask(
  event: HuggingFaceTransformersEventContext,
): string | undefined {
  const self =
    event.pipeline ??
    (event.self as HuggingFaceTransformersPipeline | undefined);
  const registeredTask = getHuggingFaceTransformersPipelineInfo(self)?.task;
  if (registeredTask !== undefined) {
    return registeredTask;
  }
  if (typeof self?.task === "string") {
    return self.task;
  }
  return undefined;
}

function extractMetadata(
  event: HuggingFaceTransformersEventContext,
  args: unknown[],
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    provider: "huggingface",
  };
  const registeredModel = getHuggingFaceTransformersPipelineInfo(
    event.pipeline ??
      (event.self as HuggingFaceTransformersPipeline | undefined),
  )?.model;
  const model =
    registeredModel ??
    modelIdentifier(
      event.pipeline ??
        (event.self as HuggingFaceTransformersPipeline | undefined),
    );
  if (model) {
    metadata.model = model;
  }

  const task = getTask(event);
  const options = task === "question-answering" ? args[2] : args[1];
  if (isObject(options)) {
    for (const key of REQUEST_METADATA_KEYS) {
      if (options[key] !== undefined) {
        metadata[key] = options[key];
      }
    }
  }
  return metadata;
}

function modelIdentifier(
  pipeline: HuggingFaceTransformersPipeline | undefined,
): string | undefined {
  const model = pipeline?.model;
  if (!isObject(model)) {
    return undefined;
  }

  const config = isObject(model.config) ? model.config : undefined;
  for (const value of [
    config?._name_or_path,
    config?.name_or_path,
    config?.model_id,
    config?.modelId,
    model.name,
  ]) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function extractInput(task: string | undefined, args: unknown[]): unknown {
  switch (task) {
    case "feature-extraction":
      return args[0];
    case "question-answering": {
      const question = args[0];
      const context = args[1];
      if (
        Array.isArray(question) &&
        Array.isArray(context) &&
        question.every((value) => typeof value === "string") &&
        context.every((value) => typeof value === "string")
      ) {
        return question.map((value, index) => [
          {
            role: "user",
            content: `Context:\n${context[index] ?? ""}\n\nQuestion:\n${value}`,
          },
        ]);
      }
      if (typeof question === "string" && typeof context === "string") {
        return [
          {
            role: "user",
            content: `Context:\n${context}\n\nQuestion:\n${question}`,
          },
        ];
      }
      return { context, question };
    }
  }

  const input = args[0];
  if (task === "text-generation" && isChat(input)) {
    return input;
  }
  if (
    task === "text-generation" &&
    Array.isArray(input) &&
    input.every(isChat)
  ) {
    return input;
  }
  if (typeof input === "string") {
    return [{ role: "user", content: input }];
  }
  if (
    Array.isArray(input) &&
    input.every((value) => typeof value === "string")
  ) {
    return input.map((value) => [
      {
        role: "user",
        content: value,
      },
    ]);
  }
  return input;
}

function isChat(value: unknown): value is Array<Record<string, unknown>> {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (message) =>
        isObject(message) &&
        typeof message.role === "string" &&
        "content" in message,
    )
  );
}

function extractOutput(task: string | undefined, result: unknown): unknown {
  switch (task) {
    case "feature-extraction":
      return summarizeEmbedding(result);
    case "question-answering":
      return choicesFromAnswers(result);
    default:
      return choicesFromGenerations(result);
  }
}

function summarizeEmbedding(
  result: unknown,
): Record<string, number> | undefined {
  if (!isObject(result) || !Array.isArray(result.dims)) {
    return undefined;
  }

  const { dims } = result;
  if (
    dims.length === 0 ||
    !dims.every((dimension) => typeof dimension === "number")
  ) {
    return undefined;
  }
  if (dims.length === 1) {
    return { embedding_length: dims[0] };
  }
  if (dims.length === 2) {
    return {
      embedding_count: dims[0],
      embedding_length: dims[1],
    };
  }
  return {
    embedding_batch_count: dims[0],
    embedding_count: dims[1],
    embedding_length: dims.at(-1) ?? 0,
  };
}

function choicesFromAnswers(result: unknown): unknown {
  const answers = Array.isArray(result) ? result.flat() : [result];
  const choices = answers.flatMap((answer, index) => {
    if (!isObject(answer) || typeof answer.answer !== "string") {
      return [];
    }

    return [
      {
        index,
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: answer.answer,
        },
      },
    ];
  });
  return choices.length > 0 ? choices : undefined;
}

function choicesFromGenerations(result: unknown): unknown {
  const generations = Array.isArray(result) ? result.flat() : [result];
  const choices = generations.flatMap((generation, index) => {
    if (!isObject(generation)) {
      return [];
    }

    const generated = generation.generated_text ?? generation.summary_text;
    let content: unknown;
    if (typeof generated === "string") {
      content = generated;
    } else if (isChat(generated)) {
      content = generated.at(-1)?.content;
    }

    if (typeof content !== "string") {
      return [];
    }

    return [
      {
        index,
        finish_reason: "stop",
        message: {
          role: "assistant",
          content,
        },
      },
    ];
  });
  return choices.length > 0 ? choices : undefined;
}

export const _exportsForTestingOnly = {
  extractInput,
  extractMetadata,
  extractOutput,
  isSupportedTask: isSupportedHuggingFaceTransformersTask,
};
