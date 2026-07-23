import { isObject } from "../../util";
import { huggingFaceTransformersChannels } from "../instrumentation/plugins/huggingface-transformers-channels";
import type {
  HuggingFaceTransformersModule,
  HuggingFaceTransformersPipeline,
  HuggingFaceTransformersPipelineConstructor,
} from "../vendor-sdk-types/huggingface-transformers";

const PIPELINE_CONSTRUCTOR_KEYS = new Set([
  "TextGenerationPipeline",
  "Text2TextGenerationPipeline",
  "SummarizationPipeline",
  "FeatureExtractionPipeline",
  "QuestionAnsweringPipeline",
]);
const SUPPORTED_TASKS = new Set([
  "text-generation",
  "text2text-generation",
  "summarization",
  "feature-extraction",
  "question-answering",
]);
const wrappedValues = new WeakMap<object, object>();

export function wrapHuggingFaceTransformers(
  transformers: HuggingFaceTransformersModule,
): HuggingFaceTransformersModule;
export function wrapHuggingFaceTransformers(
  transformers: HuggingFaceTransformersPipeline,
): HuggingFaceTransformersPipeline;
export function wrapHuggingFaceTransformers<T>(transformers: T): T;
export function wrapHuggingFaceTransformers(transformers: unknown): unknown {
  const pipelineTask = (transformers as { task?: unknown } | null)?.task;
  if (
    typeof transformers === "function" &&
    typeof pipelineTask === "string" &&
    SUPPORTED_TASKS.has(pipelineTask)
  ) {
    return wrapPipeline(transformers as HuggingFaceTransformersPipeline);
  }
  if (!isSupportedModule(transformers)) {
    return transformers;
  }
  const existing = wrappedValues.get(transformers);
  if (existing) {
    return existing;
  }

  const proxy = new Proxy(Object.create(transformers), {
    get(_target, property, receiver) {
      const value = Reflect.get(transformers, property, receiver);
      if (property === "pipeline" && typeof value === "function") {
        return wrapPipelineFactory(value);
      }
      if (
        typeof property === "string" &&
        PIPELINE_CONSTRUCTOR_KEYS.has(property) &&
        typeof value === "function"
      ) {
        return wrapPipelineConstructor(
          value as HuggingFaceTransformersPipelineConstructor,
        );
      }
      return value;
    },
  });
  wrappedValues.set(transformers, proxy);
  wrappedValues.set(proxy, proxy);
  return proxy;
}

function isSupportedModule(
  value: unknown,
): value is HuggingFaceTransformersModule {
  if (!isObject(value)) {
    return false;
  }
  return (
    typeof value.pipeline === "function" ||
    [...PIPELINE_CONSTRUCTOR_KEYS].some(
      (key) => typeof value[key] === "function",
    )
  );
}

function wrapPipelineFactory(
  factory: NonNullable<HuggingFaceTransformersModule["pipeline"]>,
): HuggingFaceTransformersModule["pipeline"] {
  const existing = wrappedValues.get(factory);
  if (existing) {
    return existing as HuggingFaceTransformersModule["pipeline"];
  }
  const wrapped = function (
    this: unknown,
    ...args: [
      task: string,
      model?: string | null,
      options?: Record<string, unknown>,
    ]
  ) {
    const [task] = args;
    const context: Parameters<
      typeof huggingFaceTransformersChannels.pipeline.tracePromise
    >[1] = {
      arguments: args,
    };
    return huggingFaceTransformersChannels.pipeline
      .tracePromise(() => Reflect.apply(factory, this, args), context)
      .then((pipeline) =>
        SUPPORTED_TASKS.has(pipeline.task ?? task)
          ? wrapPipeline(pipeline)
          : pipeline,
      );
  };
  wrappedValues.set(factory, wrapped);
  wrappedValues.set(wrapped, wrapped);
  return wrapped;
}

function wrapPipelineConstructor(
  constructor: HuggingFaceTransformersPipelineConstructor,
): HuggingFaceTransformersPipelineConstructor {
  const existing = wrappedValues.get(constructor);
  if (existing) {
    return existing as HuggingFaceTransformersPipelineConstructor;
  }
  const proxy = new Proxy(constructor, {
    construct(target, args, newTarget) {
      const pipeline = Reflect.construct(target, args, newTarget);
      return typeof pipeline.task === "string" &&
        SUPPORTED_TASKS.has(pipeline.task)
        ? wrapPipeline(pipeline)
        : pipeline;
    },
  });
  wrappedValues.set(constructor, proxy);
  wrappedValues.set(proxy, proxy);
  return proxy;
}

function wrapPipeline(
  pipeline: HuggingFaceTransformersPipeline,
): HuggingFaceTransformersPipeline {
  const existing = wrappedValues.get(pipeline);
  if (existing) {
    return existing as HuggingFaceTransformersPipeline;
  }
  const proxy = new Proxy(pipeline, {
    apply(target, thisArg, args) {
      const context: Parameters<
        typeof huggingFaceTransformersChannels.pipelineCall.tracePromise
      >[1] = {
        arguments: args as [unknown, ...unknown[]],
        self: target,
      };
      return huggingFaceTransformersChannels.pipelineCall.tracePromise(
        () => Reflect.apply(target, thisArg, args),
        context,
      );
    },
  });
  wrappedValues.set(pipeline, proxy);
  wrappedValues.set(proxy, proxy);
  return proxy;
}
