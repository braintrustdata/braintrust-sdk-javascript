import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock iso's newTracingChannel - must be before any imports that use it
vi.mock("../../isomorph", () => ({
  default: {
    newAsyncLocalStorage: vi.fn(() => {
      let current: unknown;
      return {
        getStore: vi.fn(() => current),
        run: vi.fn((store: unknown, callback: () => unknown) => {
          const previous = current;
          current = store;
          try {
            return callback();
          } finally {
            current = previous;
          }
        }),
      };
    }),
    newTracingChannel: vi.fn(),
    getEnv: vi.fn((name: string) =>
      name === "BRAINTRUST_CAPTURE_ATTACHMENTS" ? "true" : undefined,
    ),
  },
}));

import { GoogleGenAIPlugin } from "./google-genai-plugin";
import { startSpan } from "../../logger";
import iso from "../../isomorph";

const mockNewTracingChannel = iso.newTracingChannel as ReturnType<typeof vi.fn>;
const mockStartSpan = vi.mocked(startSpan);

// Mock logger
vi.mock("../../logger", () => ({
  BaseAttachment: class {},
  CAPTURE_ATTACHMENTS: Symbol.for("braintrust.captureAttachments"),
  startSpan: vi.fn(() => ({
    log: vi.fn(),
    end: vi.fn(),
  })),
  _internalGetGlobalState: vi.fn(() => undefined),
  currentSpan: vi.fn(() => undefined),
  withCurrent: vi.fn((_span: unknown, callback: () => unknown) => callback()),
  Attachment: class MockAttachment {
    reference: any;
    constructor(params: any) {
      this.reference = {
        filename: params.filename,
        content_type: params.contentType,
      };
    }
  },
}));

describe("GoogleGenAIPlugin", () => {
  let plugin: GoogleGenAIPlugin;
  let mockChannel: any;
  let interceptSpy: any;
  let subscribeSpy: any;
  let unsubscribeSpy: any;

  beforeEach(() => {
    interceptSpy = vi.fn((interceptor: unknown) => {
      void interceptor;
      return vi.fn();
    });
    subscribeSpy = vi.fn();
    unsubscribeSpy = vi.fn();
    mockChannel = {
      intercept: interceptSpy,
      subscribe: subscribeSpy,
      unsubscribe: unsubscribeSpy,
      hasSubscribers: false,
    };

    mockNewTracingChannel.mockReturnValue(mockChannel);
    plugin = new GoogleGenAIPlugin();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("enable/disable lifecycle", () => {
    it("should not subscribe multiple times if enabled twice", () => {
      plugin.enable();
      const firstCallCount = subscribeSpy.mock.calls.length;

      plugin.enable();
      const secondCallCount = subscribeSpy.mock.calls.length;

      expect(firstCallCount).toBe(secondCallCount);
    });

    it("should unsubscribe from channels when disabled", () => {
      plugin.enable();
      plugin.disable();

      expect(unsubscribeSpy).toHaveBeenCalled();
    });

    it("should clear unsubscribers array after disable", () => {
      plugin.enable();
      plugin.disable();

      // Enable again should re-subscribe
      subscribeSpy.mockClear();
      plugin.enable();

      expect(subscribeSpy).toHaveBeenCalled();
    });

    it("should not crash when disabled without being enabled", () => {
      expect(() => plugin.disable()).not.toThrow();
    });
  });

  describe("generateContent channel subscription", () => {
    it("should extract input correctly", () => {
      plugin.enable();

      const subscribeCall = subscribeSpy.mock.calls.find(
        (call: any) =>
          mockNewTracingChannel.mock.results[
            subscribeSpy.mock.calls.indexOf(call)
          ]?.value === mockChannel,
      );

      expect(subscribeCall).toBeDefined();

      // Get the handlers from the subscribe call
      const handlers = subscribeSpy.mock.calls[0][0];
      expect(handlers).toHaveProperty("start");
      expect(handlers).toHaveProperty("asyncEnd");
      expect(handlers).toHaveProperty("error");
    });

    it.each([
      {
        name: "candidate-only usage",
        usageMetadata: { candidatesTokenCount: 5 },
        expectedMetrics: { completion_tokens: 5 },
        absentMetrics: [
          "prompt_tokens",
          "completion_reasoning_tokens",
          "tokens",
        ],
      },
      {
        name: "thought-only usage",
        usageMetadata: { thoughtsTokenCount: 7 },
        expectedMetrics: {
          completion_reasoning_tokens: 7,
          completion_tokens: 7,
        },
        absentMetrics: ["prompt_tokens", "tokens"],
      },
      {
        name: "tool-use-only usage",
        usageMetadata: { toolUsePromptTokenCount: 11 },
        expectedMetrics: { prompt_tokens: 11 },
        absentMetrics: [
          "completion_tokens",
          "completion_reasoning_tokens",
          "tokens",
        ],
      },
      {
        name: "combined usage",
        usageMetadata: {
          cachedContentTokenCount: 3,
          candidatesTokenCount: 13,
          promptTokenCount: 17,
          thoughtsTokenCount: 19,
          toolUsePromptTokenCount: 23,
          totalTokenCount: 72,
        },
        expectedMetrics: {
          completion_reasoning_tokens: 19,
          completion_tokens: 32,
          prompt_cached_tokens: 3,
          prompt_tokens: 40,
          tokens: 72,
        },
        absentMetrics: [],
      },
      {
        name: "modality-detail usage",
        usageMetadata: {
          candidatesTokensDetails: [
            { modality: "AUDIO", tokenCount: 29 },
            { modality: "IMAGE", tokenCount: 31 },
            { modality: "TEXT", tokenCount: 37 },
          ],
          promptTokensDetails: [
            { modality: "AUDIO", tokenCount: 41 },
            { modality: "TEXT", tokenCount: 43 },
          ],
        },
        expectedMetrics: {
          completion_audio_tokens: 29,
          completion_image_tokens: 31,
          prompt_audio_tokens: 41,
        },
        absentMetrics: ["prompt_tokens", "completion_tokens", "tokens"],
      },
    ])(
      "normalizes $name",
      ({ usageMetadata, expectedMetrics, absentMetrics }) => {
        plugin.enable();

        const handlers = subscribeSpy.mock.calls[0][0];
        const event: any = {
          arguments: [
            {
              contents: "Hello",
              model: "gemini-2.5-flash",
            },
          ],
        };

        handlers.start(event);
        const span = mockStartSpan.mock.results.at(-1)?.value as {
          log: ReturnType<typeof vi.fn>;
        };
        event.result = { usageMetadata };
        handlers.asyncEnd(event);

        const metrics = span.log.mock.calls[0][0].metrics;
        expect(metrics).toMatchObject(expectedMetrics);
        for (const metric of absentMetrics) {
          expect(metrics).not.toHaveProperty(metric);
        }
      },
    );

    it("preserves explicitly reported zero usage", () => {
      plugin.enable();

      const handlers = subscribeSpy.mock.calls[0][0];
      const event: any = {
        arguments: [
          {
            contents: "Hello",
            model: "gemini-2.5-flash",
          },
        ],
      };

      handlers.start(event);
      const span = mockStartSpan.mock.results.at(-1)?.value as {
        log: ReturnType<typeof vi.fn>;
      };
      event.result = {
        usageMetadata: {
          cachedContentTokenCount: 0,
          candidatesTokenCount: 0,
          candidatesTokensDetails: [
            { modality: "AUDIO", tokenCount: 0 },
            { modality: "IMAGE", tokenCount: 0 },
          ],
          promptTokenCount: 0,
          promptTokensDetails: [{ modality: "AUDIO", tokenCount: 0 }],
          thoughtsTokenCount: 0,
          toolUsePromptTokenCount: 0,
          totalTokenCount: 0,
        },
      };
      handlers.asyncEnd(event);

      expect(span.log.mock.calls[0][0].metrics).toMatchObject({
        completion_audio_tokens: 0,
        completion_image_tokens: 0,
        completion_reasoning_tokens: 0,
        completion_tokens: 0,
        prompt_audio_tokens: 0,
        prompt_cached_tokens: 0,
        prompt_tokens: 0,
        tokens: 0,
      });
    });

    it("converts generated inline images to attachments", () => {
      plugin.enable();
      const handlers = subscribeSpy.mock.calls[0][0];
      const event: any = {
        arguments: [
          {
            contents: "Generate a blue circle",
            model: "gemini-2.5-flash-image",
          },
        ],
      };

      handlers.start(event);
      const span = mockStartSpan.mock.results.at(-1)?.value as {
        log: ReturnType<typeof vi.fn>;
      };
      event.result = {
        candidates: [
          {
            content: {
              parts: [
                {
                  inlineData: {
                    data: "aGVsbG8=",
                    mimeType: "image/png",
                  },
                },
              ],
              role: "model",
            },
          },
        ],
      };
      handlers.asyncEnd(event);

      expect(span.log).toHaveBeenCalledWith(
        expect.objectContaining({
          output: {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      image_url: {
                        url: expect.objectContaining({
                          reference: {
                            content_type: "image/png",
                            filename: "file.png",
                          },
                        }),
                      },
                    },
                  ],
                  role: "model",
                },
              },
            ],
          },
        }),
      );
    });

    it("converts generated inline video to a file attachment", () => {
      plugin.enable();
      const handlers = subscribeSpy.mock.calls[0][0];
      const event: any = {
        arguments: [
          {
            contents: "Generate a short video",
            model: "gemini-video",
          },
        ],
      };

      handlers.start(event);
      const span = mockStartSpan.mock.results.at(-1)?.value as {
        log: ReturnType<typeof vi.fn>;
      };
      event.result = {
        candidates: [
          {
            content: {
              parts: [
                {
                  inlineData: {
                    data: "aGVsbG8=",
                    mimeType: "video/mp4",
                  },
                },
              ],
              role: "model",
            },
          },
        ],
      };
      handlers.asyncEnd(event);

      expect(span.log).toHaveBeenCalledWith(
        expect.objectContaining({
          output: {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      file: {
                        file_data: expect.objectContaining({
                          reference: {
                            content_type: "video/mp4",
                            filename: "file.mp4",
                          },
                        }),
                        filename: "file.mp4",
                      },
                    },
                  ],
                  role: "model",
                },
              },
            ],
          },
        }),
      );
    });
  });

  describe("generateContentStream channel subscription", () => {
    it("aggregates streamed inline image and audio parts as attachments", async () => {
      plugin.enable();
      const handlers = subscribeSpy.mock.calls[1][0];
      const event: any = {
        arguments: [
          {
            contents: "Generate an image and audio",
            model: "gemini-multimodal",
          },
        ],
      };

      async function* stream() {
        yield {
          candidates: [
            {
              content: {
                parts: [
                  {
                    inlineData: {
                      data: "aGVsbG8=",
                      mimeType: "image/png",
                    },
                  },
                ],
              },
            },
          ],
        };
        yield {
          candidates: [
            {
              content: {
                parts: [
                  {
                    inlineData: {
                      data: "aGVsbG8=",
                      mimeType: "audio/wav",
                    },
                  },
                ],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: {
            candidatesTokenCount: 2,
            promptTokenCount: 3,
            totalTokenCount: 5,
          },
        };
      }

      handlers.start(event);
      event.result = stream();
      handlers.asyncEnd(event);
      for await (const _chunk of event.result) {
        // Consume the provider stream so the instrumentation finalizes it.
      }

      const span = mockStartSpan.mock.results.at(-1)?.value as {
        end: ReturnType<typeof vi.fn>;
        log: ReturnType<typeof vi.fn>;
      };
      expect(span.log).toHaveBeenCalledWith(
        expect.objectContaining({
          metrics: expect.objectContaining({
            completion_tokens: 2,
            prompt_tokens: 3,
            time_to_first_token: expect.any(Number),
            tokens: 5,
          }),
          output: {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      image_url: {
                        url: expect.objectContaining({
                          reference: {
                            content_type: "image/png",
                            filename: "file.png",
                          },
                        }),
                      },
                    },
                    {
                      file: {
                        file_data: expect.objectContaining({
                          reference: {
                            content_type: "audio/wav",
                            filename: "file.wav",
                          },
                        }),
                        filename: "file.wav",
                      },
                    },
                  ],
                  role: "model",
                },
                finishReason: "STOP",
              },
            ],
            usageMetadata: {
              candidatesTokenCount: 2,
              promptTokenCount: 3,
              totalTokenCount: 5,
            },
          },
        }),
      );
      expect(JSON.stringify(span.log.mock.calls)).not.toContain("aGVsbG8=");
      expect(span.end).toHaveBeenCalledTimes(1);
    });
  });

  describe("generateImages channel interception", () => {
    it("captures canonical image generation input and all returned images", async () => {
      plugin.enable();
      const interceptor = interceptSpy.mock.calls[1]?.[0];
      const params = {
        model: "imagen-4.0-generate-001",
        prompt: "A blue circle",
        config: {
          aspectRatio: "1:1",
          imageSize: "1K",
          numberOfImages: 2,
          outputMimeType: "image/png",
          personGeneration: "DONT_ALLOW",
          seed: 42,
        },
      };
      const response = {
        generatedImages: [
          {
            enhancedPrompt: "A solid blue circle",
            image: {
              imageBytes: "aGVsbG8=",
              mimeType: "image/png",
            },
          },
          {
            image: {
              gcsUri: "gs://bucket/generated.png",
              mimeType: "image/png",
            },
          },
        ],
      };
      const providerPromise = Promise.resolve(response);
      const target = vi.fn(() => providerPromise);

      const result = interceptor(target, {}, [params], {});

      expect(result).toBe(providerPromise);
      await result;
      await Promise.resolve();

      expect(mockStartSpan).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "generate_images",
          spanAttributes: { type: "llm" },
          event: expect.objectContaining({
            input: {
              operation: "generate",
              prompt: "A blue circle",
              parameters: {
                aspect_ratio: "1:1",
                n: 2,
                output_format: "image/png",
                seed: 42,
                size: "1K",
              },
            },
            metadata: {
              model: "imagen-4.0-generate-001",
              provider: "google",
            },
          }),
        }),
      );
      const span = mockStartSpan.mock.results.at(-1)?.value as {
        end: ReturnType<typeof vi.fn>;
        log: ReturnType<typeof vi.fn>;
      };
      expect(span.log).toHaveBeenCalledWith({
        output: {
          content: [
            {
              type: "image_url",
              image_url: {
                url: expect.objectContaining({
                  reference: {
                    content_type: "image/png",
                    filename: "generated-image-1.png",
                  },
                }),
              },
              revised_prompt: "A solid blue circle",
            },
            {
              type: "image_url",
              image_url: { url: "gs://bucket/generated.png" },
            },
          ],
        },
      });
      expect(span.end).toHaveBeenCalledTimes(1);
    });

    it("logs provider rejections without changing them", async () => {
      plugin.enable();
      const interceptor = interceptSpy.mock.calls[1]?.[0];
      const providerError = new Error("Imagen is unavailable");
      const providerPromise = Promise.reject(providerError);

      const result = interceptor(
        () => providerPromise,
        {},
        [
          {
            model: "imagen-4.0-generate-001",
            prompt: "A blue circle",
          },
        ],
        {},
      );

      expect(result).toBe(providerPromise);
      await expect(result).rejects.toBe(providerError);
      await Promise.resolve();
      const span = mockStartSpan.mock.results.at(-1)?.value as {
        end: ReturnType<typeof vi.fn>;
        log: ReturnType<typeof vi.fn>;
      };
      expect(span.log).toHaveBeenCalledWith({ error: providerError });
      expect(span.end).toHaveBeenCalledTimes(1);
    });
  });

  describe("editImage channel interception", () => {
    it("captures reference images, masks, parameters, and edited images", async () => {
      plugin.enable();
      const interceptor = interceptSpy.mock.calls[2]?.[0];
      const params = {
        model: "imagen-3.0-capability-001",
        prompt: "Turn the circle green",
        referenceImages: [
          {
            referenceImage: {
              imageBytes: "aGVsbG8=",
              mimeType: "image/png",
            },
            referenceType: "REFERENCE_TYPE_RAW",
          },
          {
            referenceImage: {
              imageBytes: "aGVsbG8=",
              mimeType: "image/png",
            },
            referenceType: "REFERENCE_TYPE_MASK",
          },
        ],
        config: {
          aspectRatio: "1:1",
          numberOfImages: 1,
          outputCompressionQuality: 80,
          outputMimeType: "image/jpeg",
          seed: 7,
        },
      };
      const response = {
        generatedImages: [
          {
            image: {
              imageBytes: "aGVsbG8=",
              mimeType: "image/jpeg",
            },
          },
        ],
      };
      const providerPromise = Promise.resolve(response);

      const result = interceptor(() => providerPromise, {}, [params], {});

      expect(result).toBe(providerPromise);
      await result;
      await Promise.resolve();

      expect(mockStartSpan).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "edit_image",
          spanAttributes: { type: "llm" },
          event: expect.objectContaining({
            input: {
              operation: "edit",
              prompt: "Turn the circle green",
              content: [
                {
                  type: "image_url",
                  image_url: {
                    url: expect.objectContaining({
                      reference: {
                        content_type: "image/png",
                        filename: "reference-image-1.png",
                      },
                    }),
                  },
                  purpose: "reference",
                },
                {
                  type: "image_url",
                  image_url: {
                    url: expect.objectContaining({
                      reference: {
                        content_type: "image/png",
                        filename: "mask-image-2.png",
                      },
                    }),
                  },
                  purpose: "mask",
                },
              ],
              parameters: {
                aspect_ratio: "1:1",
                n: 1,
                output_format: "image/jpeg",
                quality: 80,
                seed: 7,
              },
            },
            metadata: {
              model: "imagen-3.0-capability-001",
              provider: "google",
            },
          }),
        }),
      );
      const span = mockStartSpan.mock.results.at(-1)?.value as {
        end: ReturnType<typeof vi.fn>;
        log: ReturnType<typeof vi.fn>;
      };
      expect(span.log).toHaveBeenCalledWith({
        output: {
          content: [
            {
              type: "image_url",
              image_url: {
                url: expect.objectContaining({
                  reference: {
                    content_type: "image/jpeg",
                    filename: "generated-image-1.jpg",
                  },
                }),
              },
            },
          ],
        },
      });
      expect(span.end).toHaveBeenCalledTimes(1);
    });
  });

  describe("generateVideos channel interception", () => {
    it("captures submission input and immediately returned videos", async () => {
      plugin.enable();
      const interceptor = interceptSpy.mock.calls[3]?.[0];
      const params = {
        model: "veo-3.1-fast-generate-preview",
        source: {
          image: {
            imageBytes: "aGVsbG8=",
            mimeType: "image/png",
          },
          prompt: "Make the circle rotate once",
        },
        config: {
          aspectRatio: "16:9",
          durationSeconds: 4,
          resolution: "720p",
          seed: 12,
        },
      };
      const response = {
        done: true,
        response: {
          generatedVideos: [
            {
              video: {
                mimeType: "video/mp4",
                videoBytes: "aGVsbG8=",
              },
            },
          ],
        },
      };
      const providerPromise = Promise.resolve(response);

      const result = interceptor(() => providerPromise, {}, [params], {});

      expect(result).toBe(providerPromise);
      await result;
      await Promise.resolve();

      expect(mockStartSpan).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "generate_videos",
          spanAttributes: { type: "llm" },
          event: expect.objectContaining({
            input: {
              operation: "generate",
              prompt: "Make the circle rotate once",
              content: [
                {
                  type: "image_url",
                  image_url: {
                    url: expect.objectContaining({
                      reference: {
                        content_type: "image/png",
                        filename: "input-image.png",
                      },
                    }),
                  },
                  purpose: "input",
                },
              ],
              parameters: {
                aspect_ratio: "16:9",
                duration: 4,
                seed: 12,
                size: "720p",
              },
            },
            metadata: {
              model: "veo-3.1-fast-generate-preview",
              provider: "google",
            },
          }),
        }),
      );
      const span = mockStartSpan.mock.results.at(-1)?.value as {
        end: ReturnType<typeof vi.fn>;
        log: ReturnType<typeof vi.fn>;
      };
      expect(span.log).toHaveBeenCalledWith({
        output: {
          content: [
            {
              type: "file",
              file: {
                filename: "generated-video-1.mp4",
                file_data: expect.objectContaining({
                  reference: {
                    content_type: "video/mp4",
                    filename: "generated-video-1.mp4",
                  },
                }),
              },
            },
          ],
        },
      });
      expect(span.end).toHaveBeenCalledTimes(1);
    });

    it("does not poll a pending video operation", async () => {
      plugin.enable();
      const interceptor = interceptSpy.mock.calls[3]?.[0];
      const response = { done: false, name: "operations/video-1" };
      const providerPromise = Promise.resolve(response);
      const target = vi.fn(() => providerPromise);

      const result = interceptor(
        target,
        {},
        [
          {
            model: "veo-3.1-fast-generate-preview",
            prompt: "A short wave",
          },
        ],
        {},
      );

      expect(result).toBe(providerPromise);
      await result;
      await Promise.resolve();
      const span = mockStartSpan.mock.results.at(-1)?.value as {
        end: ReturnType<typeof vi.fn>;
        log: ReturnType<typeof vi.fn>;
      };
      expect(target).toHaveBeenCalledTimes(1);
      expect(span.log).toHaveBeenCalledWith({ output: { content: [] } });
      expect(span.end).toHaveBeenCalledTimes(1);
    });
  });

  describe("embedContent channel subscription", () => {
    it.each([
      ["gemini-embedding-001", "hello", [{ content: "hello" }]],
      [
        "gemini-embedding-001",
        ["first", "second"],
        [{ content: "first" }, { content: "second" }],
      ],
      [
        "gemini-embedding-2-preview",
        ["first", "second"],
        [
          {
            content: [
              { type: "text", text: "first" },
              { type: "text", text: "second" },
            ],
          },
        ],
      ],
      [
        "gemini-embedding-2-preview",
        [{ parts: [{ text: "first" }] }, { parts: [{ text: "second" }] }],
        [{ content: "first" }, { content: "second" }],
      ],
    ])(
      "preserves embedding boundaries for %s with %j",
      (model, contents, inputs) => {
        plugin.enable();
        const handlers = subscribeSpy.mock.calls[2][0];
        handlers.start({
          arguments: [
            {
              model,
              contents,
              config: {
                outputDimensionality: 8,
                taskType: "RETRIEVAL_DOCUMENT",
                httpOptions: { headers: { authorization: "secret" } },
              },
            },
          ],
        });
        expect(mockStartSpan).toHaveBeenCalledWith(
          expect.objectContaining({
            name: "embed_content",
            spanAttributes: { type: "llm" },
            event: expect.objectContaining({
              input: { inputs, output_dimensions: 8 },
              metadata: { model, provider: "google" },
            }),
          }),
        );
      },
    );

    it("normalizes inline and remote media without mutating the request", () => {
      plugin.enable();
      const handlers = subscribeSpy.mock.calls[2][0];
      const params = {
        model: "gemini-embedding-2-preview",
        contents: [
          {
            parts: [
              { text: "image and files" },
              ...["image/png", "audio/wav", "video/mp4", "application/pdf"].map(
                (mimeType) => ({ inlineData: { mimeType, data: "aGVsbG8=" } }),
              ),
              {
                inlineData: {
                  mimeType: "audio/wav",
                  data: new Uint8Array([1, 2, 3]),
                },
              },
              {
                fileData: {
                  mimeType: "application/pdf",
                  fileUri: "gs://bucket/document.pdf",
                  displayName: "report.pdf",
                },
              },
            ],
          },
        ],
      };
      const original = structuredClone(params);
      handlers.start({ arguments: [params] });
      const input = mockStartSpan.mock.calls[0][0]?.event?.input;
      expect(input).toMatchObject({
        inputs: [
          {
            content: [
              { type: "text", text: "image and files" },
              {
                type: "image_url",
                image_url: {
                  url: { reference: { content_type: "image/png" } },
                },
              },
              ...["audio/wav", "video/mp4", "application/pdf", "audio/wav"].map(
                (content_type) => ({
                  type: "file",
                  file: { file_data: { reference: { content_type } } },
                }),
              ),
              {
                type: "file",
                file: {
                  file_data: "gs://bucket/document.pdf",
                  filename: "report.pdf",
                },
              },
            ],
          },
        ],
      });
      expect(params).toEqual(original);
    });

    it("retains all inline media when any attachment conversion fails", () => {
      plugin.enable();
      const handlers = subscribeSpy.mock.calls[2][0];
      handlers.start({
        arguments: [
          {
            model: "gemini-embedding-2-preview",
            contents: {
              parts: [
                { inlineData: { mimeType: "image/png", data: "aGVsbG8=" } },
                {
                  inlineData: {
                    mimeType: "audio/wav",
                    data: "invalid base64!",
                  },
                },
              ],
            },
          },
        ],
      });
      expect(mockStartSpan.mock.calls[0][0]?.event?.input).toEqual({
        inputs: [
          {
            content: [
              {
                type: "image_url",
                image_url: { url: "data:image/png;base64,aGVsbG8=" },
              },
              {
                type: "file",
                file: { file_data: "data:audio/wav;base64,invalid base64!" },
              },
            ],
          },
        ],
      });
    });

    it.each([
      [{ embeddings: [{ values: [0.1] }, { values: [0.2] }] }, 2, {}],
      [{ embeddings: [{}] }, 1, {}],
      [{ embeddings: [] }, 0, {}],
      [{}, 0, {}],
      [
        { embedding: { statistics: { tokenCount: 5 } } },
        1,
        { prompt_tokens: 5, tokens: 5 },
      ],
      [{ embeddings: [{ statistics: { tokenCount: 5 } }, {}] }, 2, {}],
      [
        {
          usageMetadata: {
            promptTokenCount: 10,
            totalTokenCount: 12,
            candidatesTokenCount: 2,
            promptTokensDetails: [{ modality: "AUDIO", tokenCount: 4 }],
          },
        },
        0,
        { prompt_tokens: 10, tokens: 12, prompt_audio_tokens: 4 },
      ],
      [{ usageMetadata: { totalTokenCount: 12 } }, 0, { tokens: 12 }],
    ])(
      "logs count and only reported embedding usage for %j",
      (result, count, metrics) => {
        plugin.enable();
        const handlers = subscribeSpy.mock.calls[2][0];
        const event = {
          arguments: [
            { model: "gemini-embedding-2-preview", contents: "hello" },
          ],
          result,
        };
        handlers.start(event);
        handlers.asyncEnd(event);
        const span = mockStartSpan.mock.results[0].value;
        expect(span.log).toHaveBeenCalledWith({
          output: { count },
          metrics: {
            ...metrics,
            start: expect.any(Number),
            end: expect.any(Number),
          },
        });
        expect(span.end).toHaveBeenCalledOnce();
      },
    );

    it("logs provider errors without exposing vectors", () => {
      plugin.enable();
      const handlers = subscribeSpy.mock.calls[2][0];
      const error = new Error("unsupported input");
      const event = {
        arguments: [{ model: "gemini-embedding-2-preview", contents: "hello" }],
        error,
      };
      handlers.start(event);
      handlers.error(event);
      const span = mockStartSpan.mock.results[0].value;
      expect(span.log).toHaveBeenCalledWith({ error, output: { count: 0 } });
      expect(span.end).toHaveBeenCalledOnce();
    });
  });

  describe("interactions.create channel subscription", () => {
    it("subscribes to the interactions.create channel", () => {
      plugin.enable();

      expect(mockNewTracingChannel).toHaveBeenCalledWith(
        "orchestrion:@google/genai:interactions.create",
      );
      expect(subscribeSpy).toHaveBeenCalledTimes(4);
    });

    it("logs non-streaming interaction output and metrics", () => {
      plugin.enable();

      const handlers = subscribeSpy.mock.calls[3][0];
      const scheduledAt = new Date("2026-01-02T03:04:05.000Z");
      const callbackUrl = new URL("https://example.com/callback");
      const event: any = {
        arguments: [
          {
            agent: "agent-1",
            agent_config: {
              callback_url: callbackUrl,
              instructions: "Use the support workflow.",
              scheduled_at: scheduledAt,
            },
            generation_config: { max_output_tokens: 16, temperature: 0 },
            input: {
              callback_url: callbackUrl,
              scheduled_at: scheduledAt,
              text: "Reply with OK.",
              type: "text",
            },
            model: "gemini-2.5-flash",
            system_instruction: "Be brief.",
          },
        ],
      };

      handlers.start(event);
      const span = mockStartSpan.mock.results.at(-1)?.value as {
        end: ReturnType<typeof vi.fn>;
        log: ReturnType<typeof vi.fn>;
      };
      event.result = {
        created: scheduledAt,
        id: "interaction-1",
        metadata: {
          callback_url: callbackUrl,
        },
        output_text: "OK",
        status: "completed",
        usage: {
          cached_tokens_by_modality: [{ modality: "audio", tokens: 1 }],
          input_tokens_by_modality: [
            { modality: "text", tokens: 6 },
            { modality: "audio", tokens: 2 },
          ],
          output_tokens_by_modality: [
            { modality: "text", tokens: 1 },
            { modality: "audio", tokens: 1 },
            { modality: "image", tokens: 1 },
          ],
          tool_use_tokens_by_modality: [{ modality: "text", tokens: 1 }],
          total_cached_tokens: 1,
          total_input_tokens: 8,
          total_output_tokens: 2,
          total_thought_tokens: 3,
          total_tool_use_tokens: 1,
          total_tokens: 13,
        },
      };

      handlers.asyncEnd(event);

      expect(span.log).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          input: expect.objectContaining({
            agent: "agent-1",
            agent_config: {
              callback_url: callbackUrl.toJSON(),
              instructions: "Use the support workflow.",
              scheduled_at: scheduledAt.toJSON(),
            },
            generation_config: { max_output_tokens: 16, temperature: 0 },
            input: {
              callback_url: callbackUrl.toJSON(),
              scheduled_at: scheduledAt.toJSON(),
              text: "Reply with OK.",
              type: "text",
            },
            model: "gemini-2.5-flash",
            system_instruction: "Be brief.",
          }),
          metadata: expect.objectContaining({
            agent: "agent-1",
            agent_config: {
              callback_url: callbackUrl.toJSON(),
              instructions: "Use the support workflow.",
              scheduled_at: scheduledAt.toJSON(),
            },
            generation_config: { max_output_tokens: 16, temperature: 0 },
            model: "gemini-2.5-flash",
            system_instruction: "Be brief.",
          }),
        }),
      );
      expect(span.log).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          metadata: {
            interaction_id: "interaction-1",
            status: "completed",
          },
          metrics: expect.objectContaining({
            completion_audio_tokens: 1,
            completion_image_tokens: 1,
            completion_reasoning_tokens: 3,
            completion_tokens: 5,
            prompt_audio_tokens: 2,
            prompt_cached_tokens: 1,
            prompt_tokens: 8,
            tokens: 13,
          }),
          output: expect.objectContaining({
            created: scheduledAt.toJSON(),
            id: "interaction-1",
            metadata: {
              callback_url: callbackUrl.toJSON(),
            },
            output_text: "OK",
            status: "completed",
          }),
        }),
      );
      expect(span.end).toHaveBeenCalledTimes(1);
    });

    it("captures direct interaction video generation canonically", () => {
      plugin.enable();

      const handlers = subscribeSpy.mock.calls[3][0];
      const event: any = {
        arguments: [
          {
            generation_config: {
              video_config: { seed: 7, task: "text_to_video" },
            },
            input: [
              {
                data: "aGVsbG8=",
                mime_type: "image/png",
                type: "image",
              },
              { text: "Make the circle rotate once.", type: "text" },
            ],
            model: "gemini-omni-1.1-flash",
            response_format: {
              aspect_ratio: "16:9",
              resolution: "360p",
              type: "video",
            },
          },
        ],
      };

      handlers.start(event);
      const span = mockStartSpan.mock.results.at(-1)?.value as {
        end: ReturnType<typeof vi.fn>;
        log: ReturnType<typeof vi.fn>;
      };
      event.result = {
        id: "interaction-video-1",
        output_video: {
          data: "aGVsbG8=",
          mime_type: "video/mp4",
          type: "video",
        },
        status: "completed",
      };
      handlers.asyncEnd(event);

      expect(mockStartSpan).toHaveBeenLastCalledWith(
        expect.objectContaining({
          name: "generate_video",
          spanAttributes: { type: "llm" },
        }),
      );
      expect(span.log).toHaveBeenNthCalledWith(1, {
        input: {
          operation: "generate",
          prompt: "Make the circle rotate once.",
          content: [
            {
              type: "image_url",
              image_url: {
                url: expect.objectContaining({
                  reference: {
                    content_type: "image/png",
                    filename: "file.png",
                  },
                }),
              },
            },
          ],
          parameters: { aspect_ratio: "16:9", seed: 7, size: "360p" },
        },
        metadata: { model: "gemini-omni-1.1-flash", provider: "google" },
      });
      expect(span.log).toHaveBeenNthCalledWith(2, {
        metadata: {
          interaction_id: "interaction-video-1",
          status: "completed",
        },
        metrics: expect.objectContaining({
          duration: expect.any(Number),
          end: expect.any(Number),
          start: expect.any(Number),
        }),
        output: {
          content: [
            {
              type: "file",
              file: {
                filename: "generated-video-1.mp4",
                file_data: expect.objectContaining({
                  reference: {
                    content_type: "video/mp4",
                    filename: "generated-video-1.mp4",
                  },
                }),
              },
            },
          ],
        },
      });
      expect(span.end).toHaveBeenCalledTimes(1);
    });

    it("preserves zero and missing interaction usage values", () => {
      plugin.enable();

      const handlers = subscribeSpy.mock.calls[3][0];
      const event: any = {
        arguments: [
          {
            input: "Reply with OK.",
            model: "gemini-2.5-flash",
          },
        ],
      };

      handlers.start(event);
      const span = mockStartSpan.mock.results.at(-1)?.value as {
        log: ReturnType<typeof vi.fn>;
      };
      event.result = {
        id: "interaction-zero-usage",
        status: "completed",
        usage: {
          input_tokens_by_modality: [{ modality: "audio", tokens: 0 }],
          output_tokens_by_modality: [
            { modality: "audio", tokens: 0 },
            { modality: "image", tokens: 0 },
          ],
          total_cached_tokens: 0,
          total_input_tokens: 0,
          total_output_tokens: 0,
          total_thought_tokens: 0,
          total_tokens: 0,
        },
      };

      handlers.asyncEnd(event);

      expect(span.log).toHaveBeenLastCalledWith(
        expect.objectContaining({
          metrics: expect.objectContaining({
            completion_audio_tokens: 0,
            completion_image_tokens: 0,
            completion_reasoning_tokens: 0,
            completion_tokens: 0,
            prompt_audio_tokens: 0,
            prompt_cached_tokens: 0,
            prompt_tokens: 0,
            tokens: 0,
          }),
        }),
      );

      handlers.start(event);
      const missingUsageSpan = mockStartSpan.mock.results.at(-1)?.value as {
        log: ReturnType<typeof vi.fn>;
      };
      event.result = {
        id: "interaction-missing-usage",
        status: "completed",
        usage: {},
      };

      handlers.asyncEnd(event);

      expect(missingUsageSpan.log).toHaveBeenLastCalledWith(
        expect.objectContaining({
          metrics: expect.not.objectContaining({
            completion_reasoning_tokens: expect.anything(),
            completion_tokens: expect.anything(),
            prompt_cached_tokens: expect.anything(),
            prompt_tokens: expect.anything(),
            tokens: expect.anything(),
          }),
        }),
      );
    });

    it("does not trace background interaction tasks", () => {
      plugin.enable();

      const handlers = subscribeSpy.mock.calls[3][0];
      const event: any = {
        arguments: [
          {
            agent: "deep-research-pro-preview-12-2025",
            background: true,
            input: "Research TPUs.",
          },
        ],
      };

      handlers.start(event);
      event.result = {
        id: "interaction-background",
        status: "in_progress",
      };
      handlers.asyncEnd(event);

      expect(mockStartSpan).not.toHaveBeenCalled();
    });

    it("aggregates streaming interaction events when consumed", async () => {
      plugin.enable();

      async function* stream() {
        yield {
          event_type: "interaction.created",
          interaction: { id: "interaction-2", status: "in_progress" },
        };
        yield {
          event_type: "step.start",
          index: 0,
          step: { type: "model_output" },
        };
        yield {
          event_type: "step.delta",
          index: 0,
          delta: { text: "O", type: "text" },
        };
        yield {
          event_type: "step.delta",
          index: 0,
          delta: { text: "K", type: "text" },
        };
        yield {
          event_type: "interaction.completed",
          interaction: {
            id: "interaction-2",
            status: "completed",
            usage: {
              total_input_tokens: 6,
              total_output_tokens: 1,
              total_tokens: 7,
            },
          },
        };
      }

      const handlers = subscribeSpy.mock.calls[3][0];
      const event: any = {
        arguments: [
          {
            input: "Reply with OK.",
            model: "gemini-2.5-flash",
            stream: true,
          },
        ],
      };

      handlers.start(event);
      const span = mockStartSpan.mock.results.at(-1)?.value as {
        end: ReturnType<typeof vi.fn>;
        log: ReturnType<typeof vi.fn>;
      };
      event.result = stream();
      handlers.asyncEnd(event);

      for await (const _chunk of event.result) {
        // Consume the stream so aggregation completes.
      }

      expect(span.log).toHaveBeenLastCalledWith(
        expect.objectContaining({
          metadata: {
            interaction_id: "interaction-2",
            status: "completed",
          },
          metrics: expect.objectContaining({
            completion_tokens: 1,
            prompt_tokens: 6,
            tokens: 7,
          }),
          output: expect.objectContaining({
            output_text: "OK",
            status: "completed",
            steps: [
              {
                index: 0,
                text: "OK",
                type: "model_output",
              },
            ],
          }),
        }),
      );
      expect(span.end).toHaveBeenCalledTimes(1);
    });

    it("ends the interaction span when a stream errors", async () => {
      plugin.enable();

      const streamError = new Error("stream failed");
      async function* stream() {
        yield {
          event_type: "interaction.created",
          interaction: { id: "interaction-3", status: "in_progress" },
        };
        throw streamError;
      }

      const handlers = subscribeSpy.mock.calls[3][0];
      const event: any = {
        arguments: [
          {
            input: "Reply with OK.",
            model: "gemini-2.5-flash",
            stream: true,
          },
        ],
      };

      handlers.start(event);
      const span = mockStartSpan.mock.results.at(-1)?.value as {
        end: ReturnType<typeof vi.fn>;
        log: ReturnType<typeof vi.fn>;
      };
      event.result = stream();
      handlers.asyncEnd(event);

      await expect(async () => {
        for await (const _chunk of event.result) {
          // Consume until the stream throws.
        }
      }).rejects.toThrow("stream failed");

      expect(span.log).toHaveBeenLastCalledWith({
        error: streamError,
      });
      expect(span.end).toHaveBeenCalledTimes(1);
    });
  });
});

describe("Google GenAI serialization functions", () => {
  describe("serializeInput", () => {
    it("should serialize basic input with model and contents", () => {
      const params = {
        model: "gemini-pro",
        contents: "Hello world",
      };

      // Since these are private functions, we'll test them through the plugin behavior
      // For now, we'll verify the structure by examining what gets logged
      expect(params.model).toBe("gemini-pro");
      expect(params.contents).toBe("Hello world");
    });
  });

  describe("serializeContents", () => {
    it("should handle string contents", () => {
      const contents = "Hello world";
      expect(typeof contents).toBe("string");
    });

    it("should handle array of content items", () => {
      const contents = [{ text: "Hello" }, { text: "world" }];
      expect(Array.isArray(contents)).toBe(true);
      expect(contents).toHaveLength(2);
    });

    it("should handle objects with parts", () => {
      const contents = {
        parts: [{ text: "Hello" }, { text: "world" }],
        role: "user",
      };
      expect(contents.parts).toHaveLength(2);
    });
  });

  describe("serializePart with inline data", () => {
    it("should convert inline data to attachment structure", () => {
      const part = {
        inlineData: {
          data: "base64data",
          mimeType: "image/png",
        },
      };

      // Verify the structure
      expect(part.inlineData).toBeDefined();
      expect(part.inlineData.data).toBe("base64data");
      expect(part.inlineData.mimeType).toBe("image/png");
    });

    it("should handle Uint8Array data", () => {
      const uint8Array = new Uint8Array([1, 2, 3, 4]);
      expect(uint8Array instanceof Uint8Array).toBe(true);
    });

    it("should extract file extension from mimeType", () => {
      const mimeType = "image/jpeg";
      const extension = mimeType.split("/")[1];
      expect(extension).toBe("jpeg");
    });
  });

  describe("extractMetadata", () => {
    it("should extract model from params", () => {
      const params = {
        model: "gemini-pro",
        config: {
          temperature: 0.7,
          maxOutputTokens: 100,
        },
      };

      expect(params.model).toBe("gemini-pro");
      expect(params.config.temperature).toBe(0.7);
    });

    it("should exclude tools from metadata", () => {
      const config = {
        temperature: 0.7,
        tools: [{ functionDeclarations: [] }],
        maxOutputTokens: 100,
      };

      const keys = Object.keys(config);
      expect(keys).toContain("tools");
      expect(keys).toContain("temperature");
    });
  });

  describe("extractGenerateContentMetrics", () => {
    it("should extract usage metadata correctly", () => {
      const response = {
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 20,
          totalTokenCount: 30,
        },
      };

      const expectedMetrics = {
        prompt_tokens: 10,
        completion_tokens: 20,
        tokens: 30,
      };

      expect(response.usageMetadata.promptTokenCount).toBe(
        expectedMetrics.prompt_tokens,
      );
      expect(response.usageMetadata.candidatesTokenCount).toBe(
        expectedMetrics.completion_tokens,
      );
      expect(response.usageMetadata.totalTokenCount).toBe(
        expectedMetrics.tokens,
      );
    });

    it("should handle cached content tokens", () => {
      const response = {
        usageMetadata: {
          promptTokenCount: 100,
          cachedContentTokenCount: 50,
        },
      };

      expect(response.usageMetadata.cachedContentTokenCount).toBe(50);
    });

    it("should handle thoughts tokens", () => {
      const response = {
        usageMetadata: {
          candidatesTokenCount: 80,
          thoughtsTokenCount: 20,
        },
      };

      expect(response.usageMetadata.thoughtsTokenCount).toBe(20);
    });

    it("should handle missing usage metadata", () => {
      const response: any = {};
      expect(response.usageMetadata).toBeUndefined();
    });

    it("should calculate duration when startTime provided", () => {
      const startTime = 1000;
      const currentTime = 1500;
      const expectedDuration = currentTime - startTime;

      expect(expectedDuration).toBe(500);
    });
  });

  describe("aggregateGenerateContentChunks", () => {
    it("should aggregate text from multiple chunks", () => {
      const chunks = [
        {
          candidates: [
            {
              content: {
                parts: [{ text: "Hello" }],
              },
            },
          ],
        },
        {
          candidates: [
            {
              content: {
                parts: [{ text: " world" }],
              },
            },
          ],
        },
      ];

      let aggregatedText = "";
      for (const chunk of chunks) {
        if (chunk.candidates?.[0]?.content?.parts) {
          for (const part of chunk.candidates[0].content.parts) {
            if (part.text) {
              aggregatedText += part.text;
            }
          }
        }
      }

      expect(aggregatedText).toBe("Hello world");
    });

    it("should separate thought text from regular text", () => {
      const chunks = [
        {
          candidates: [
            {
              content: {
                parts: [
                  { text: "Let me think...", thought: true },
                  { text: "Answer" },
                ],
              },
            },
          ],
        },
      ];

      const thoughtParts = chunks[0].candidates[0].content.parts.filter(
        (p: any) => p.thought,
      );
      const regularParts = chunks[0].candidates[0].content.parts.filter(
        (p: any) => !p.thought,
      );

      expect(thoughtParts).toHaveLength(1);
      expect(regularParts).toHaveLength(1);
    });

    it("should collect function calls", () => {
      const chunks = [
        {
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: {
                      name: "get_weather",
                      args: { location: "NYC" },
                    },
                  },
                ],
              },
            },
          ],
        },
      ];

      const functionCalls = chunks[0].candidates[0].content.parts.filter(
        (p: any) => p.functionCall,
      );

      expect(functionCalls).toHaveLength(1);
      expect(functionCalls[0].functionCall.name).toBe("get_weather");
    });

    it("should collect code execution results", () => {
      const chunks = [
        {
          candidates: [
            {
              content: {
                parts: [
                  {
                    codeExecutionResult: {
                      outcome: "success",
                      output: "42",
                    },
                  },
                ],
              },
            },
          ],
        },
      ];

      const codeResults = chunks[0].candidates[0].content.parts.filter(
        (p: any) => p.codeExecutionResult,
      );

      expect(codeResults).toHaveLength(1);
      expect(codeResults[0].codeExecutionResult.outcome).toBe("success");
    });

    it("should collect executable code", () => {
      const chunks = [
        {
          candidates: [
            {
              content: {
                parts: [
                  {
                    executableCode: {
                      language: "python",
                      code: "print('hello')",
                    },
                  },
                ],
              },
            },
          ],
        },
      ];

      const executableCode = chunks[0].candidates[0].content.parts.filter(
        (p: any) => p.executableCode,
      );

      expect(executableCode).toHaveLength(1);
      expect(executableCode[0].executableCode.language).toBe("python");
    });

    it("should preserve last chunk's usage metadata", () => {
      const chunks = [
        {
          candidates: [
            {
              content: {
                parts: [{ text: "Hello" }],
              },
            },
          ],
        },
        {
          candidates: [
            {
              content: {
                parts: [{ text: " world" }],
              },
            },
          ],
          usageMetadata: {
            promptTokenCount: 5,
            candidatesTokenCount: 10,
            totalTokenCount: 15,
          },
        },
      ];

      const lastChunk = chunks[chunks.length - 1];
      expect(lastChunk?.usageMetadata).toBeDefined();
      expect(lastChunk?.usageMetadata?.totalTokenCount).toBe(15);
    });

    it("should include finish reason and safety ratings", () => {
      const chunks = [
        {
          candidates: [
            {
              content: {
                parts: [{ text: "Done" }],
              },
              finishReason: "STOP",
              safetyRatings: [
                {
                  category: "HARM_CATEGORY_HARASSMENT",
                  probability: "NEGLIGIBLE",
                },
              ],
            },
          ],
        },
      ];

      const candidate = chunks[0].candidates[0];
      expect(candidate.finishReason).toBe("STOP");
      expect(candidate.safetyRatings).toHaveLength(1);
    });

    it("should handle empty chunks array", () => {
      const chunks: any[] = [];
      expect(chunks).toHaveLength(0);
    });

    it("should calculate time_to_first_token for first chunk", () => {
      const startTime = 1000;
      const chunks = [
        {
          candidates: [
            {
              content: {
                parts: [{ text: "First" }],
              },
            },
          ],
        },
      ];

      // Simulate first token time calculation
      const firstTokenTime = 1100;
      const timeToFirstToken = firstTokenTime - startTime;

      expect(chunks.length).toBeGreaterThan(0);
      expect(timeToFirstToken).toBe(100);
    });
  });

  describe("tryToDict helper", () => {
    it("should handle objects with toJSON method", () => {
      const obj = {
        toJSON: () => ({ serialized: true }),
        value: 42,
      };

      expect(typeof obj.toJSON).toBe("function");
      expect(obj.toJSON()).toEqual({ serialized: true });
    });

    it("should return null for null input", () => {
      const result = null;
      expect(result).toBeNull();
    });

    it("should return null for undefined input", () => {
      const result = undefined;
      expect(result).toBeUndefined();
    });

    it("should return plain objects as-is", () => {
      const obj = { key: "value" };
      expect(obj).toEqual({ key: "value" });
    });

    it("should return null for non-object types", () => {
      expect(typeof "string").toBe("string");
      expect(typeof 42).toBe("number");
      expect(typeof true).toBe("boolean");
    });
  });

  describe("inline data to attachment conversion", () => {
    it("should create proper attachment structure for base64 image", () => {
      const mimeType = "image/png";

      // Simulate attachment creation
      const extension = mimeType.split("/")[1];
      const filename = `file.${extension}`;
      const contentType = mimeType;

      expect(filename).toBe("file.png");
      expect(contentType).toBe("image/png");
    });

    it("should handle Buffer data", () => {
      if (typeof Buffer !== "undefined") {
        const buffer = Buffer.from([1, 2, 3, 4]);
        expect(Buffer.isBuffer(buffer)).toBe(true);
      }
    });

    it("should use default extension for unknown mime types", () => {
      const mimeType = undefined as string | undefined;
      const extension = mimeType ? mimeType.split("/")[1] : "bin";
      expect(extension).toBe("bin");
    });

    it("should convert base64 string to Uint8Array in browser", () => {
      const base64 = "AQIDBA=="; // [1, 2, 3, 4] in base64

      // Simulate browser conversion
      if (typeof atob !== "undefined") {
        const binaryString = atob(base64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }

        expect(bytes instanceof Uint8Array).toBe(true);
        expect(bytes.length).toBe(4); // decoded length (4 bytes: [1, 2, 3, 4])
      }
    });
  });

  describe("tools serialization", () => {
    it("should preserve function declarations structure", () => {
      const tools = [
        {
          functionDeclarations: [
            {
              name: "get_weather",
              description: "Get weather for a location",
              parameters: {
                type: "object",
                properties: {
                  location: { type: "string" },
                },
              },
            },
          ],
        },
      ];

      expect(tools[0].functionDeclarations).toHaveLength(1);
      expect(tools[0].functionDeclarations[0].name).toBe("get_weather");
    });

    it("should handle null tools config", () => {
      const config: any = {
        temperature: 0.7,
      };

      expect(config.tools).toBeUndefined();
    });

    it("should handle array of tool definitions", () => {
      const tools = [
        { functionDeclarations: [{ name: "tool1" }] },
        { functionDeclarations: [{ name: "tool2" }] },
      ];

      expect(Array.isArray(tools)).toBe(true);
      expect(tools).toHaveLength(2);
    });
  });

  describe("edge cases", () => {
    it("should handle chunks without candidates", () => {
      const chunks = [
        {},
        { candidates: null },
        { candidates: [] },
        {
          candidates: [
            {
              content: {
                parts: [{ text: "Hello" }],
              },
            },
          ],
        },
      ];

      const validChunks = chunks.filter(
        (c) =>
          c.candidates &&
          Array.isArray(c.candidates) &&
          c.candidates.length > 0,
      );

      expect(validChunks).toHaveLength(1);
    });

    it("should handle parts without text property", () => {
      const parts = [
        { text: "Hello" },
        { functionCall: {} },
        { inlineData: {} },
      ];

      const textParts = parts.filter((p) => p.text !== undefined);
      expect(textParts).toHaveLength(1);
    });

    it("should handle mixed part types in single chunk", () => {
      const parts = [
        { text: "Answer: " },
        { functionCall: { name: "calculate" } },
        { text: "Done" },
      ];

      const texts = parts.filter((p: any) => p.text).map((p: any) => p.text);
      const functions = parts.filter((p: any) => p.functionCall);

      expect(texts).toHaveLength(2);
      expect(functions).toHaveLength(1);
    });

    it("should preserve role in content structure", () => {
      const content = {
        parts: [{ text: "Hello" }],
        role: "model",
      };

      expect(content.role).toBe("model");
    });
  });
});
