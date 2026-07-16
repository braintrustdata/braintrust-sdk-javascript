import {
  defaultSettingsMiddleware,
  wrapLanguageModel,
  type LanguageModel,
  type LanguageModelMiddleware,
} from "ai";

const deterministicReasoningMiddleware: LanguageModelMiddleware = {
  specificationVersion: "v4",
  wrapStream: async ({ doStream }) => {
    const { stream, ...rest } = await doStream();
    type StreamPart =
      typeof stream extends ReadableStream<infer Part> ? Part : never;
    let injected = false;
    return {
      ...rest,
      stream: stream.pipeThrough(
        new TransformStream<StreamPart, StreamPart>({
          transform(chunk, controller) {
            if (
              !injected &&
              chunk.type !== "stream-start" &&
              chunk.type !== "response-metadata"
            ) {
              controller.enqueue({
                id: "eve-e2e-reasoning",
                type: "reasoning-start",
              });
              controller.enqueue({
                delta: "Inspect the current Eve step before continuing.",
                id: "eve-e2e-reasoning",
                type: "reasoning-delta",
              });
              controller.enqueue({
                id: "eve-e2e-reasoning",
                type: "reasoning-end",
              });
              injected = true;
            }
            controller.enqueue(chunk);
          },
        }),
      ),
    };
  },
};

export function withReadableReasoning(model: LanguageModel): LanguageModel {
  return wrapLanguageModel({
    middleware: [
      defaultSettingsMiddleware({
        settings: {
          providerOptions: {
            openai: {
              reasoningSummary: "auto",
            },
          },
        },
      }),
      deterministicReasoningMiddleware,
    ],
    model,
  });
}
