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
    await voyageAIChannels.embed.invoke(
      async () => ({
        data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }],
        model: "voyage-4",
        usage: { totalTokens: 4 },
      }),
      undefined,
      [
        {
          input: ["Braintrust tracing"],
          inputType: "document",
          model: "voyage-4",
          outputDimension: 3,
        },
      ],
      {},
    );

    await voyageAIChannels.rerank.invoke(
      async () => ({
        data: [
          { index: 1, relevanceScore: 0.95 },
          { index: 0, relevanceScore: 0.4 },
        ],
        model: "rerank-2.5",
        usage: { totalTokens: 9 },
      }),
      undefined,
      [
        {
          documents: ["Vienna", "Paris"],
          model: "rerank-2.5",
          query: "capital of France",
          topK: 2,
        },
      ],
      {},
    );

    const spans = await backgroundLogger.drain();
    const embedSpan = spans.find(
      (span: any) => span.span_attributes?.name === "voyageai.embed",
    ) as Record<string, any> | undefined;
    const rerankSpan = spans.find(
      (span: any) => span.span_attributes?.name === "voyageai.rerank",
    ) as Record<string, any> | undefined;

    expect(embedSpan).toMatchObject({
      input: {
        inputs: [{ content: "Braintrust tracing" }],
        output_dimensions: 3,
      },
      metadata: {
        model: "voyage-4",
        provider: "voyage",
      },
      metrics: { prompt_tokens: 4, tokens: 4 },
      output: { count: 1 },
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
    await voyageAIChannels.multimodalEmbed.invoke(
      async () => ({
        data: [{ embedding: [0.1, 0.2], index: 0 }],
        model: "voyage-multimodal-3.5",
        usage: { totalTokens: 5 },
      }),
      undefined,
      [
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
      {},
    );

    await voyageAIChannels.contextualizedEmbed.invoke(
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
      undefined,
      [
        {
          inputs: [["First chunk", "Second chunk"]],
          model: "voyage-context-3",
          outputDimension: 3,
        },
      ],
      {},
    );

    const spans = await backgroundLogger.drain();
    const multimodalSpan = spans.find(
      (span: any) => span.span_attributes?.name === "voyageai.multimodalEmbed",
    ) as Record<string, any> | undefined;
    const contextualizedSpan = spans.find(
      (span: any) =>
        span.span_attributes?.name === "voyageai.contextualizedEmbed",
    ) as Record<string, any> | undefined;

    expect(multimodalSpan).toMatchObject({
      input: {
        inputs: [
          {
            content: [
              { type: "text", text: "A banana" },
              {
                type: "image_url",
                image_url: { url: "https://example.com/banana.jpg" },
              },
            ],
          },
        ],
      },
      metadata: {
        model: "voyage-multimodal-3.5",
        provider: "voyage",
      },
      metrics: { prompt_tokens: 5, tokens: 5 },
      output: { count: 1 },
    });
    expect(contextualizedSpan).toMatchObject({
      input: {
        inputs: [{ content: "First chunk" }, { content: "Second chunk" }],
        output_dimensions: 3,
      },
      metadata: {
        model: "voyage-context-3",
        provider: "voyage",
      },
      metrics: { prompt_tokens: 7, tokens: 7 },
      output: { count: 2 },
    });
  });

  it("converts Voyage base64 media inputs to attachments", async () => {
    await voyageAIChannels.multimodalEmbed.invoke(
      async () => ({
        data: [{ embedding: [0.1, 0.2], index: 0 }],
        model: "voyage-multimodal-3.5",
        usage: { totalTokens: 5 },
      }),
      undefined,
      [
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
      {},
    );

    const spans = await backgroundLogger.drain();
    const span = spans.find(
      (candidate: any) =>
        candidate.span_attributes?.name === "voyageai.multimodalEmbed",
    ) as Record<string, any> | undefined;
    const attachment = span?.input?.inputs?.[0]?.content?.[0]?.image_url?.url;

    expect(attachment).toBeInstanceOf(Attachment);
    expect(attachment.reference).toMatchObject({
      content_type: "image/png",
      filename: "image.png",
      type: "braintrust_attachment",
    });
  });

  it("falls back to the complete canonical input when attachment conversion fails", async () => {
    const validDataUrl = "data:image/png;base64,aGVsbG8=";
    const invalidDataUrl = "data:image/png;base64,%%%";
    await voyageAIChannels.multimodalEmbed.invoke(
      async () => ({
        data: [{ embedding: [0.1], index: 0 }],
        model: "voyage-multimodal-3.5",
      }),
      undefined,
      [
        {
          inputs: [
            {
              content: [
                { imageBase64: validDataUrl, type: "image_base64" },
                { imageBase64: invalidDataUrl, type: "image_base64" },
              ],
            },
          ],
          model: "voyage-multimodal-3.5",
        },
      ],
      {},
    );

    const spans = await backgroundLogger.drain();
    const span = spans.find(
      (candidate: any) =>
        candidate.span_attributes?.name === "voyageai.multimodalEmbed",
    ) as Record<string, any> | undefined;

    expect(span?.input).toEqual({
      inputs: [
        {
          content: [
            { image_url: { url: validDataUrl }, type: "image_url" },
            { image_url: { url: invalidDataUrl }, type: "image_url" },
          ],
        },
      ],
    });
  });

  it("omits unavailable embedding usage metrics", async () => {
    await voyageAIChannels.embed.invoke(
      async () => ({
        data: [{ embedding: [0.1], index: 0 }],
        model: "voyage-4",
      }),
      undefined,
      [{ input: "hello", model: "voyage-4" }],
      {},
    );

    const spans = await backgroundLogger.drain();
    const span = spans.find(
      (candidate: any) => candidate.span_attributes?.name === "voyageai.embed",
    ) as Record<string, any> | undefined;

    expect(span?.input).toEqual({ inputs: [{ content: "hello" }] });
    expect(span?.output).toEqual({ count: 1 });
    expect(span?.metrics).not.toHaveProperty("prompt_tokens");
    expect(span?.metrics).not.toHaveProperty("tokens");
  });

  it("suppresses nested auto-instrumentation invocations", async () => {
    const request = { input: "hello", model: "voyage-4" };

    await voyageAIChannels.embed.invoke(
      function (innerRequest, options) {
        return voyageAIChannels.embed.invoke(
          async () => ({
            data: [{ embedding: [0.1], index: 0 }],
            model: "voyage-4",
            usage: { totalTokens: 1 },
          }),
          this,
          [innerRequest, options],
          {},
        );
      },
      undefined,
      [request],
      {},
    );

    const spans = await backgroundLogger.drain();
    expect(
      spans.filter(
        (span: any) => span.span_attributes?.name === "voyageai.embed",
      ),
    ).toHaveLength(1);
  });
});
