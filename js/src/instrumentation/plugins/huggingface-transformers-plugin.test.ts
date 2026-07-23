import { describe, expect, it } from "vitest";
import {
  registerHuggingFaceTransformersPipeline,
  type HuggingFaceTransformersEventContext,
} from "./huggingface-transformers-channels";
import { _exportsForTestingOnly } from "./huggingface-transformers-plugin";
import type { HuggingFaceTransformersPipeline } from "../../vendor-sdk-types/huggingface-transformers";

const { extractInput, extractMetadata, extractOutput, isSupportedTask } =
  _exportsForTestingOnly;

describe("HuggingFaceTransformersPlugin extraction", () => {
  it("normalizes generation and chat payloads", () => {
    expect(extractInput("text-generation", ["Hello"])).toEqual([
      { role: "user", content: "Hello" },
    ]);
    expect(
      extractInput("text-generation", [[{ role: "user", content: "Hello" }]]),
    ).toEqual([{ role: "user", content: "Hello" }]);
    expect(
      extractOutput("text-generation", [
        {
          generated_text: [
            { role: "user", content: "Hello" },
            { role: "assistant", content: "Hi!" },
          ],
        },
      ]),
    ).toEqual([
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: "Hi!" },
      },
    ]);
  });

  it("normalizes text-to-text, summarization, and question answering", () => {
    expect(
      extractOutput("text2text-generation", [{ generated_text: "translated" }]),
    ).toEqual([
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: "translated" },
      },
    ]);
    expect(
      extractOutput("summarization", [{ summary_text: "summary" }]),
    ).toEqual([
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: "summary" },
      },
    ]);
    expect(
      extractInput("question-answering", ["Who built it?", "Ada built it."]),
    ).toEqual([
      {
        role: "user",
        content: "Context:\nAda built it.\n\nQuestion:\nWho built it?",
      },
    ]);
    expect(
      extractOutput("question-answering", {
        answer: "Ada",
        score: 0.99,
      }),
    ).toEqual([
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: "Ada" },
      },
    ]);
  });

  it("summarizes feature extraction tensors without logging vectors", () => {
    expect(
      extractOutput("feature-extraction", {
        dims: [2, 5, 384],
        data: new Float32Array(2 * 5 * 384),
      }),
    ).toEqual({
      embedding_batch_count: 2,
      embedding_count: 5,
      embedding_length: 384,
    });
  });

  it("uses factory metadata and only keeps allowed request settings", () => {
    const pipeline: HuggingFaceTransformersPipeline = Object.assign(
      async () => [],
      {
        task: "text-generation",
        model: { config: { model_type: "gpt2" } },
      },
    );
    registerHuggingFaceTransformersPipeline(
      pipeline,
      "text-generation",
      "onnx-community/tiny-model",
    );

    expect(
      extractMetadata(
        { self: pipeline } satisfies HuggingFaceTransformersEventContext,
        [
          "Hello",
          {
            temperature: 0,
            top_p: 0.9,
            max_new_tokens: 5,
          },
        ],
      ),
    ).toEqual({
      model: "onnx-community/tiny-model",
      provider: "huggingface",
      temperature: 0,
      top_p: 0.9,
    });
  });

  it("limits tracing to the approved pipeline tasks", () => {
    expect(isSupportedTask("feature-extraction")).toBe(true);
    expect(isSupportedTask("text-classification")).toBe(false);
  });
});
