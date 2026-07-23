import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import {
  _exportsForTestingOnly,
  initLogger,
  type TestBackgroundLogger,
} from "../logger";
import { configureNode } from "../node/config";
import { wrapHuggingFaceTransformers } from "./huggingface-transformers";
import type {
  HuggingFaceTransformersModule,
  HuggingFaceTransformersPipeline,
  HuggingFaceTransformersPipelineConstructor,
} from "../vendor-sdk-types/huggingface-transformers";

try {
  configureNode();
} catch {
  // Shared process setup in tests can run this more than once.
}

function makePipeline(task: string): HuggingFaceTransformersPipeline {
  const outputs: Record<string, unknown> = {
    "text-generation": [{ generated_text: "Hello world" }],
    "text2text-generation": [{ generated_text: "Bonjour" }],
    summarization: [{ summary_text: "Short summary" }],
    "feature-extraction": {
      dims: [1, 3],
      data: new Float32Array([0.1, 0.2, 0.3]),
    },
    "question-answering": { answer: "Ada", score: 0.99 },
  };
  return Object.assign(async (..._args: unknown[]) => outputs[task], {
    task,
    model: {
      config: { _name_or_path: "instance-model" },
    },
  });
}

function makeModule(): HuggingFaceTransformersModule {
  return {
    pipeline: async (task: string) => makePipeline(task),
  };
}

describe("wrapHuggingFaceTransformers", () => {
  let backgroundLogger: TestBackgroundLogger;

  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
  });

  beforeEach(() => {
    backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({
      projectName: "huggingface-transformers.test.ts",
      projectId: "test-project-id",
    });
  });

  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
  });

  test("traces the five supported pipeline tasks through the factory", async () => {
    const transformers = wrapHuggingFaceTransformers(makeModule());
    const calls = [
      ["text-generation", ["Hello", { temperature: 0 }]],
      ["text2text-generation", ["Hello"]],
      ["summarization", ["Long text"]],
      ["feature-extraction", ["Embedding input"]],
      ["question-answering", ["Who?", "Ada did."]],
    ] as const;

    for (const [task, args] of calls) {
      const pipeline = await transformers.pipeline?.(task, `model/${task}`);
      await pipeline?.(...args);
    }

    const spans = await backgroundLogger.drain();
    expect(spans).toHaveLength(5);
    expect(spans).toMatchObject([
      {
        span_attributes: {
          name: "huggingface.transformers.text_generation",
        },
      },
      {
        span_attributes: {
          name: "huggingface.transformers.text2text_generation",
        },
      },
      {
        span_attributes: {
          name: "huggingface.transformers.summarization",
        },
      },
      {
        span_attributes: {
          name: "huggingface.transformers.feature_extraction",
        },
      },
      {
        span_attributes: {
          name: "huggingface.transformers.question_answering",
        },
      },
    ]);
    expect(spans[0]).toMatchObject({
      input: [{ role: "user", content: "Hello" }],
      metadata: {
        model: "model/text-generation",
        provider: "huggingface",
        temperature: 0,
      },
      output: [
        {
          index: 0,
          message: { role: "assistant", content: "Hello world" },
        },
      ],
      span_attributes: { type: "llm" },
    });
    expect(spans[3]).toMatchObject({
      output: {
        embedding_count: 1,
        embedding_length: 3,
      },
    });
  });

  test("wraps exported pipeline constructors and is idempotent", async () => {
    const module: HuggingFaceTransformersModule = {
      TextGenerationPipeline: function (options: { task: string }) {
        return makePipeline(options.task);
      } as unknown as HuggingFaceTransformersPipelineConstructor,
    };
    const wrapped = wrapHuggingFaceTransformers(module);
    expect(wrapHuggingFaceTransformers(wrapped)).toBe(wrapped);

    const Pipeline = wrapped.TextGenerationPipeline;
    const pipeline = Pipeline
      ? new Pipeline({ task: "text-generation" })
      : undefined;
    expect(pipeline && wrapHuggingFaceTransformers(pipeline)).toBe(pipeline);
    await pipeline?.("Hello");

    const spans = await backgroundLogger.drain();
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      metadata: {
        model: "instance-model",
        provider: "huggingface",
      },
      span_attributes: {
        name: "huggingface.transformers.text_generation",
      },
    });
  });

  test("does not trace unsupported tasks", async () => {
    const transformers = wrapHuggingFaceTransformers(makeModule());
    const pipeline = await transformers.pipeline?.(
      "text-classification",
      "model/classifier",
    );
    await pipeline?.("Hello");

    expect(await backgroundLogger.drain()).toHaveLength(0);
  });

  test("propagates pipeline errors and logs the original failure", async () => {
    const failure = new Error("local inference failed");
    const pipeline: HuggingFaceTransformersPipeline = Object.assign(
      async (..._args: unknown[]) => {
        throw failure;
      },
      { task: "text-generation" },
    );
    const wrapped = wrapHuggingFaceTransformers(pipeline);

    await expect(wrapped("Hello")).rejects.toBe(failure);
    const spans = await backgroundLogger.drain();
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      error: "local inference failed",
    });
  });
});
