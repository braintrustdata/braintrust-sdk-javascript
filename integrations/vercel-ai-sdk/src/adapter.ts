import { BraintrustStream, BraintrustStreamChunk } from "braintrust";

/**
 * @deprecated Use the AI SDK integration exported by `braintrust` instead. This package will stop being published after the next release.
 */
export interface AIStreamCallbacksAndOptions {
  onStart?: () => void | Promise<void>;
  onCompletion?: (completion: string) => void | Promise<void>;
  onFinal?: (completion: string) => void | Promise<void>;
  onToken?: (token: string) => void | Promise<void>;
  onText?: (text: string) => void | Promise<void>;
}

function formatStreamPart(type: "text" | "data", value: unknown): string {
  const code = type === "text" ? "0" : "2";
  return `${code}:${JSON.stringify(value)}\n`;
}

import { ReadableStream, TransformStream } from "stream/web";

/**
 * @deprecated Use `BraintrustStream` from `braintrust` with the current AI SDK response APIs instead. This package will stop being published after the next release.
 */
export type BraintrustStreamOrReadable =
  | BraintrustStream
  | ReadableStream<BraintrustStreamChunk>
  | ReadableStream<string>
  | ReadableStream<Uint8Array>;

/**
 * @deprecated Use `BraintrustStream` from `braintrust` with the current AI SDK stream APIs instead. This package will stop being published after the next release.
 */
export function toAIStream(
  stream: BraintrustStreamOrReadable,
  callbacks?: AIStreamCallbacksAndOptions,
): ReadableStream<Uint8Array> {
  const btStream =
    stream instanceof BraintrustStream
      ? stream
      : new BraintrustStream(stream as ReadableStream<BraintrustStreamChunk>);

  return btStream
    .toReadableStream()
    .pipeThrough(btStreamToAISDKTransformStream(callbacks));
}

/**
 * @deprecated Use `BraintrustStream` from `braintrust` with the current AI SDK response APIs instead. This package will stop being published after the next release.
 */
export function toDataStreamResponse(
  stream: BraintrustStreamOrReadable,
  init?: ResponseInit,
): Response {
  return new Response(toAIStream(stream), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
    },
    ...init,
  });
}

/**
 * @deprecated Use `BraintrustStream` from `braintrust` with the current AI SDK response APIs instead. This package will stop being published after the next release.
 */
export function toAIStreamResponse(
  stream: BraintrustStreamOrReadable,
  init?: ResponseInit,
): Response {
  return toDataStreamResponse(stream, init);
}

function btStreamToAISDKTransformStream(
  callbacks?: AIStreamCallbacksAndOptions,
) {
  const encoder = new TextEncoder();
  const jsonChunks: string[] = [];
  const textChunks: string[] = [];
  return new TransformStream<BraintrustStreamChunk, Uint8Array>({
    async start(controller) {
      if (callbacks?.onStart) {
        await callbacks.onStart();
      }
    },
    async transform(chunk, controller) {
      switch (chunk.type) {
        case "text_delta":
          controller.enqueue(
            encoder.encode(formatStreamPart("text", chunk.data)),
          );

          // Call me old fashioned, but I think it's worth checking the existence of
          // each function to avoid unnecessary context switches.
          if (callbacks?.onToken) {
            await callbacks.onToken(chunk.data);
          }
          if (callbacks?.onText) {
            await callbacks.onText(chunk.data);
          }

          if (callbacks?.onCompletion || callbacks?.onFinal) {
            textChunks.push(chunk.data);
          }

          break;
        case "json_delta":
          jsonChunks.push(chunk.data);
          break;
      }
    },
    async flush(controller) {
      if (jsonChunks.length > 0) {
        const jsonString = jsonChunks.join("");
        const data = JSON.parse(jsonString);
        controller.enqueue(encoder.encode(formatStreamPart("data", data)));
        if (callbacks?.onFinal) {
          await callbacks.onFinal(jsonString);
        }
      } else {
        const textData = textChunks.join("");
        if (callbacks?.onCompletion) {
          await callbacks.onCompletion(textData);
        }
        if (callbacks?.onFinal) {
          await callbacks.onFinal(textData);
        }
      }

      controller.terminate();
    },
  });
}
