import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { configureNode } from "../node/config";
import {
  _exportsForTestingOnly,
  initLogger,
  Logger,
  TestBackgroundLogger,
} from "../logger";
import { wrapHuggingFace } from "./huggingface";

try {
  configureNode();
} catch {
  // Shared process setup in tests can run this more than once.
}

function buildFakeClientClass() {
  return class FakeInferenceClient {
    public constructor(
      _accessToken = "",
      _defaultOptions: Record<string, unknown> = {},
    ) {}

    public chatCompletion = async (params: {
      model?: string;
      messages?: unknown;
    }) => ({
      id: "chatcmpl_test",
      object: "chat.completion",
      model: params.model,
      usage: {
        prompt_tokens: 6,
        completion_tokens: 1,
        total_tokens: 7,
      },
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Paris",
          },
          finish_reason: "stop",
        },
      ],
    });

    public chatCompletionStream = (params: { model?: string }) =>
      (async function* () {
        yield {
          id: "chatcmpl_stream",
          model: params.model,
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                content: "Par",
              },
            },
          ],
        };
        yield {
          id: "chatcmpl_stream",
          model: params.model,
          usage: {
            prompt_tokens: 6,
            completion_tokens: 1,
            total_tokens: 7,
          },
          choices: [
            {
              index: 0,
              delta: {
                content: "is",
              },
              finish_reason: "stop",
            },
          ],
        };
      })();

    public textGeneration = async (params: { model?: string }) => ({
      generated_text: "Paris",
      details: {
        finish_reason: "eos_token",
        generated_tokens: 1,
        prefill: [{ id: 1, text: "Prompt" }],
      },
      model: params.model,
    });

    public textGenerationStream = () =>
      (async function* () {
        yield {
          token: {
            id: 1,
            text: "Par",
            logprob: 0,
            special: false,
          },
          generated_text: null,
          details: null,
        };
        yield {
          token: {
            id: 2,
            text: "is",
            logprob: 0,
            special: false,
          },
          generated_text: "Paris",
          details: {
            finish_reason: "stop_sequence",
            generated_tokens: 2,
            prefill: [{ id: 0, text: "Prompt" }],
            tokens: [
              { id: 1, text: "Par", logprob: 0, special: false },
              { id: 2, text: "is", logprob: 0, special: false },
            ],
          },
        };
      })();

    public featureExtraction = async () => [[0.1, 0.2, 0.3]];

    public endpoint(_endpointUrl: string) {
      return new FakeInferenceClient();
    }
  };
}

function buildModernModule() {
  const FakeInferenceClient = buildFakeClientClass();
  const fakeClient = new FakeInferenceClient();

  return {
    InferenceClient: FakeInferenceClient,
    chatCompletion: fakeClient.chatCompletion,
    chatCompletionStream: fakeClient.chatCompletionStream,
    textGeneration: fakeClient.textGeneration,
    textGenerationStream: fakeClient.textGenerationStream,
    featureExtraction: fakeClient.featureExtraction,
  };
}

function buildLegacyModule() {
  const FakeInferenceClient = buildFakeClientClass();
  const fakeClient = new FakeInferenceClient();

  return {
    HfInference: FakeInferenceClient,
    featureExtraction: fakeClient.featureExtraction,
  };
}

function buildCompletionStyleTextGenerationModule() {
  const FakeInferenceClient = buildFakeClientClass();
  const fakeClient = new FakeInferenceClient();

  return {
    InferenceClient: FakeInferenceClient,
    textGenerationStream: () =>
      (async function* () {
        yield {
          id: "textgen_stream",
          object: "text_completion",
          model: "meta-llama/Meta-Llama-3.1-8B",
          choices: [
            {
              index: 0,
              text: "Par",
              finish_reason: null,
            },
          ],
        };
        yield {
          id: "textgen_stream",
          object: "text_completion",
          model: "meta-llama/Meta-Llama-3.1-8B",
          choices: [
            {
              index: 0,
              text: "is",
              finish_reason: "stop",
            },
          ],
        };
        yield {
          id: "textgen_stream",
          object: "text_completion",
          model: "meta-llama/Meta-Llama-3.1-8B",
          choices: [],
          usage: {
            prompt_tokens: 5,
            completion_tokens: 2,
            total_tokens: 7,
          },
        };
      })(),
    chatCompletion: fakeClient.chatCompletion,
    chatCompletionStream: fakeClient.chatCompletionStream,
    textGeneration: fakeClient.textGeneration,
    featureExtraction: fakeClient.featureExtraction,
  };
}

async function collectAsync<T>(records: AsyncIterable<T>) {
  const items: T[] = [];
  for await (const record of records) {
    items.push(record);
  }
  return items;
}

describe("wrapHuggingFace", () => {
  let backgroundLogger: TestBackgroundLogger;
  let _logger: Logger<false>;

  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
  });

  beforeEach(() => {
    backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    _logger = initLogger({
      projectName: "huggingface.test.ts",
      projectId: "test-project-id",
    });
  });

  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
  });

  test("wraps InferenceClient chatCompletion calls", async () => {
    const { InferenceClient } = wrapHuggingFace(buildModernModule());
    const client = new InferenceClient("hf_test");

    await client.chatCompletion({
      model: "Qwen/Qwen3-32B",
      messages: [{ role: "user", content: "Reply with exactly PARIS." }],
      temperature: 0,
    });

    const spans = await backgroundLogger.drain();
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      span_attributes: {
        name: "huggingface.chat_completion",
        type: "llm",
      },
      metadata: expect.objectContaining({
        model: "Qwen/Qwen3-32B",
        provider: "huggingface",
      }),
      metrics: expect.objectContaining({
        prompt_tokens: 6,
        completion_tokens: 1,
        tokens: 7,
      }),
      output: [
        expect.objectContaining({
          message: expect.objectContaining({
            content: "Paris",
          }),
        }),
      ],
    });
  });

  test("wraps direct textGenerationStream exports", async () => {
    const huggingFace = wrapHuggingFace(buildModernModule());

    const stream = huggingFace.textGenerationStream!(
      {
        model: "mistralai/Mixtral-8x7B-v0.1",
        inputs: "Reply with exactly PARIS.",
      },
      {},
    );
    const chunks = await collectAsync(stream);

    expect(chunks).toHaveLength(2);

    const spans = await backgroundLogger.drain();
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      span_attributes: {
        name: "huggingface.text_generation_stream",
        type: "llm",
      },
      metadata: expect.objectContaining({
        model: "mistralai/Mixtral-8x7B-v0.1",
        provider: "huggingface",
        finish_reason: "stop_sequence",
      }),
      metrics: expect.objectContaining({
        prompt_tokens: 1,
        completion_tokens: 2,
        tokens: 3,
        time_to_first_token: expect.any(Number),
      }),
      output: expect.objectContaining({
        generated_text: "Paris",
      }),
    });
  });

  test("supports legacy HfInference exports and feature extraction", async () => {
    const huggingFace = wrapHuggingFace(buildLegacyModule());
    const client = new huggingFace.HfInference!("hf_test");

    await client.endpoint("https://example.invalid").chatCompletion({
      model: "Qwen/Qwen3-32B",
      messages: [{ role: "user", content: "Reply with exactly PARIS." }],
    });
    await huggingFace.featureExtraction!(
      {
        model: "sentence-transformers/distilbert-base-nli-mean-tokens",
        inputs: "Paris France",
        dimensions: 3,
      },
      {},
    );

    const spans = await backgroundLogger.drain();
    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({
      span_attributes: {
        name: "huggingface.chat_completion",
      },
    });
    expect(spans[1]).toMatchObject({
      span_attributes: {
        name: "huggingface.feature_extraction",
        type: "llm",
      },
      metadata: expect.objectContaining({
        dimensions: 3,
        model: "sentence-transformers/distilbert-base-nli-mean-tokens",
        provider: "huggingface",
      }),
      output: expect.objectContaining({
        embedding_count: 1,
        embedding_length: 3,
      }),
    });
  });

  test("wraps completion-style textGenerationStream chunks", async () => {
    const huggingFace = wrapHuggingFace(
      buildCompletionStyleTextGenerationModule(),
    );

    const stream = huggingFace.textGenerationStream!(
      {
        model: "meta-llama/Llama-3.1-8B",
        inputs: "The capital of France is",
      },
      {},
    );
    const chunks = await collectAsync(stream);

    expect(chunks).toHaveLength(3);

    const spans = await backgroundLogger.drain();
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      span_attributes: {
        name: "huggingface.text_generation_stream",
        type: "llm",
      },
      metadata: expect.objectContaining({
        model: "meta-llama/Llama-3.1-8B",
        provider: "huggingface",
        finish_reason: "stop",
      }),
      metrics: expect.objectContaining({
        prompt_tokens: 5,
        completion_tokens: 2,
        tokens: 7,
        time_to_first_token: expect.any(Number),
      }),
      output: expect.objectContaining({
        generated_text: "Paris",
        finish_reason: "stop",
      }),
    });
  });
});
