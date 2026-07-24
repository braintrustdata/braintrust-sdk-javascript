import { BasePlugin } from "../core";
import { traceAsyncChannel, unsubscribeAll } from "../core/channel-tracing";
import type { ChannelMessage } from "../core/channel-definitions";
import type { IsoChannelHandlers, IsoTracingChannel } from "../../isomorph";
import { SpanTypeAttribute, isObject } from "../../../util";
import type {
  HuggingFaceTransformersPipeline,
  HuggingFaceTransformersTask,
  HuggingFaceTransformersTensor,
} from "../../vendor-sdk-types/huggingface-transformers";
import {
  getHuggingFaceTransformersPipelineInfo,
  huggingFaceTransformersChannels,
  registerHuggingFaceTransformersPipeline,
  type HuggingFaceTransformersEventContext,
} from "./huggingface-transformers-channels";

const SUPPORTED_TASKS: ReadonlySet<string> = new Set([
  "text-generation",
  "text2text-generation",
  "summarization",
  "feature-extraction",
  "question-answering",
]);

export class HuggingFaceTransformersPlugin extends BasePlugin {
  protected onEnable(): void {
    this.subscribeToPipelineFactory();
    this.unsubscribers.push(
      traceAsyncChannel(huggingFaceTransformersChannels.pipelineCall, {
        name: (_args, event) =>
          `huggingface.transformers.${getTask(event as HuggingFaceTransformersEventContext)?.replaceAll("-", "_") ?? "unknown"}`,
        type: SpanTypeAttribute.LLM,
        shouldTrace: (_args, event) =>
          isSupportedTask(
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
      }),
    );
  }

  protected onDisable(): void {
    this.unsubscribers = unsubscribeAll(this.unsubscribers);
  }

  private subscribeToPipelineFactory(): void {
    const channel =
      huggingFaceTransformersChannels.pipeline.tracingChannel() as IsoTracingChannel<
        ChannelMessage<typeof huggingFaceTransformersChannels.pipeline>
      >;
    const handlers: IsoChannelHandlers<
      ChannelMessage<typeof huggingFaceTransformersChannels.pipeline>
    > = {
      asyncEnd: (event) => {
        if (typeof event.result !== "function") {
          return;
        }
        registerHuggingFaceTransformersPipeline(
          event.result,
          event.arguments?.[0],
          event.arguments?.[1],
        );
      },
    };

    channel.subscribe(handlers);
    this.unsubscribers.push(() => channel.unsubscribe(handlers));
  }
}

function isSupportedTask(
  task: string | undefined,
): task is HuggingFaceTransformersTask {
  return task !== undefined && SUPPORTED_TASKS.has(task);
}

function getTask(
  event: HuggingFaceTransformersEventContext,
): string | undefined {
  const self = event.self;
  return (
    getHuggingFaceTransformersPipelineInfo(self)?.task ??
    (typeof self?.task === "string" ? self.task : undefined)
  );
}

function extractMetadata(
  event: HuggingFaceTransformersEventContext,
  args: unknown[],
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    provider: "huggingface",
  };
  const registeredModel = getHuggingFaceTransformersPipelineInfo(
    event.self,
  )?.model;
  const model = registeredModel ?? modelIdentifier(event.self);
  if (model) {
    metadata.model = model;
  }

  const task = getTask(event);
  const options =
    task === "question-answering" ? args[2] : isObject(args[1]) ? args[1] : {};
  if (isObject(options)) {
    for (const key of ["temperature", "top_p", "max_tokens", "stop"]) {
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
  if (task === "feature-extraction") {
    return args[0];
  }

  if (task === "question-answering") {
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
    return input.map((value) => [{ role: "user", content: value }]);
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
  if (task === "feature-extraction") {
    return summarizeEmbedding(result);
  }
  if (task === "question-answering") {
    return choicesFromAnswers(result);
  }
  return choicesFromGenerations(result);
}

function summarizeEmbedding(
  result: unknown,
): Record<string, number> | undefined {
  if (!isObject(result) || !Array.isArray(result.dims)) {
    return undefined;
  }

  const dims = (result as HuggingFaceTransformersTensor).dims;
  if (
    !dims ||
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
  const choices = answers.flatMap((answer, index) =>
    isObject(answer) && typeof answer.answer === "string"
      ? [
          {
            index,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: answer.answer,
            },
          },
        ]
      : [],
  );
  return choices.length > 0 ? choices : undefined;
}

function choicesFromGenerations(result: unknown): unknown {
  const generations = Array.isArray(result) ? result.flat() : [result];
  const choices = generations.flatMap((generation, index) => {
    if (!isObject(generation)) {
      return [];
    }
    const generated =
      generation.generated_text ?? generation.summary_text ?? undefined;
    const content =
      typeof generated === "string"
        ? generated
        : isChat(generated)
          ? generated.at(-1)?.content
          : undefined;
    return typeof content === "string"
      ? [
          {
            index,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content,
            },
          },
        ]
      : [];
  });
  return choices.length > 0 ? choices : undefined;
}

export const _exportsForTestingOnly = {
  extractInput,
  extractMetadata,
  extractOutput,
  isSupportedTask,
};
