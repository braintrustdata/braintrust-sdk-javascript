import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Attachment, _exportsForTestingOnly, initLogger } from "../../logger";
import { configureNode } from "../../node/config";
import { voyageAIChannels } from "./voyageai-channels";

try {
  configureNode();
} catch {
  // Best-effort initialization for test environments.
}

describe("VoyageAIPlugin", () => {
  let backgroundLogger: ReturnType<
    typeof _exportsForTestingOnly.useTestBackgroundLogger
  >;

  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
  });

  beforeEach(() => {
    backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({
      projectName: "voyageai-plugin.test.ts",
      projectId: "test-project-id",
    });
  });

  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
  });

  it("captures embedding and reranking operations", async () => {
    await voyageAIChannels.embed.tracePromise(
      async () => ({
        data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }],
        model: "voyage-4",
        usage: { totalTokens: 4 },
      }),
      {
        arguments: [
          {
            input: ["Braintrust tracing"],
            inputType: "document",
            model: "voyage-4",
            outputDimension: 3,
          },
        ],
      },
    );

    await voyageAIChannels.rerank.tracePromise(
      async () => ({
        data: [
          { index: 1, relevanceScore: 0.95 },
          { index: 0, relevanceScore: 0.4 },
        ],
        model: "rerank-2.5",
        usage: { totalTokens: 9 },
      }),
      {
        arguments: [
          {
            documents: ["Vienna", "Paris"],
            model: "rerank-2.5",
            query: "capital of France",
            topK: 2,
          },
        ],
      },
    );

    const spans = await backgroundLogger.drain();
    const embedSpan = spans.find(
      (span: any) => span.span_attributes?.name === "voyageai.embed",
    ) as Record<string, any> | undefined;
    const rerankSpan = spans.find(
      (span: any) => span.span_attributes?.name === "voyageai.rerank",
    ) as Record<string, any> | undefined;

    expect(embedSpan).toMatchObject({
      input: ["Braintrust tracing"],
      metadata: {
        inputType: "document",
        model: "voyage-4",
        outputDimension: 3,
        provider: "voyage",
      },
      metrics: { tokens: 4 },
      output: {
        embedding_count: 1,
        embedding_length: 3,
      },
    });
    expect(rerankSpan).toMatchObject({
      input: {
        documents: ["Vienna", "Paris"],
        query: "capital of France",
      },
      metadata: {
        document_count: 2,
        model: "rerank-2.5",
        provider: "voyage",
        topK: 2,
      },
      metrics: { tokens: 9 },
      output: [
        { index: 1, relevance_score: 0.95 },
        { index: 0, relevance_score: 0.4 },
      ],
    });
  });

  it("normalizes multimodal and contextualized embedding summaries", async () => {
    await voyageAIChannels.multimodalEmbed.tracePromise(
      async () => ({
        data: [{ embedding: [0.1, 0.2], index: 0 }],
        model: "voyage-multimodal-3.5",
        usage: { totalTokens: 5 },
      }),
      {
        arguments: [
          {
            inputs: [
              {
                content: [
                  { type: "text", text: "A banana" },
                  {
                    type: "image_url",
                    image_url: "https://example.com/banana.jpg",
                  },
                ],
              },
            ],
            model: "voyage-multimodal-3.5",
          },
        ],
      },
    );

    await voyageAIChannels.contextualizedEmbed.tracePromise(
      async () => ({
        results: [
          {
            embeddings: [
              [0.1, 0.2, 0.3],
              [0.4, 0.5, 0.6],
            ],
            index: 0,
          },
        ],
        totalTokens: 7,
        rawResponse: {
          model: "voyage-context-3",
        },
      }),
      {
        arguments: [
          {
            inputs: [["First chunk", "Second chunk"]],
            model: "voyage-context-3",
          },
        ],
      },
    );

    const spans = await backgroundLogger.drain();
    const multimodalSpan = spans.find(
      (span: any) => span.span_attributes?.name === "voyageai.multimodalEmbed",
    ) as Record<string, any> | undefined;
    const contextualizedSpan = spans.find(
      (span: any) =>
        span.span_attributes?.name === "voyageai.contextualizedEmbed",
    ) as Record<string, any> | undefined;

    expect(multimodalSpan?.output).toEqual({
      embedding_count: 1,
      embedding_length: 2,
    });
    expect(contextualizedSpan).toMatchObject({
      metadata: {
        model: "voyage-context-3",
        provider: "voyage",
      },
      metrics: { tokens: 7 },
      output: {
        document_count: 1,
        embedding_count: 2,
        embedding_length: 3,
      },
    });
  });

  it("converts Voyage base64 media inputs to attachments", async () => {
    await voyageAIChannels.multimodalEmbed.tracePromise(
      async () => ({
        data: [{ embedding: [0.1, 0.2], index: 0 }],
        model: "voyage-multimodal-3.5",
        usage: { totalTokens: 5 },
      }),
      {
        arguments: [
          {
            inputs: [
              {
                content: [
                  {
                    imageBase64: "data:image/png;base64,aGVsbG8=",
                    type: "image_base64",
                  },
                ],
              },
            ],
            model: "voyage-multimodal-3.5",
          },
        ],
      },
    );

    const spans = await backgroundLogger.drain();
    const span = spans.find(
      (candidate: any) =>
        candidate.span_attributes?.name === "voyageai.multimodalEmbed",
    ) as Record<string, any> | undefined;
    const attachment = span?.input?.[0]?.content?.[0]?.imageBase64;

    expect(attachment).toBeInstanceOf(Attachment);
    expect(attachment.reference).toMatchObject({
      content_type: "image/png",
      filename: "image.png",
      type: "braintrust_attachment",
    });
  });
});
