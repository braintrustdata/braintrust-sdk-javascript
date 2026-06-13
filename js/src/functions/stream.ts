import {
  type CallEventType as CallEventSchema,
  CallEvent as callEventSchema,
  SSEConsoleEventData as sseConsoleEventDataSchema,
  SSEProgressEventData as sseProgressEventDataSchema,
} from "../generated_types";
import {
  createParser,
  EventSourceParser,
  ParsedEvent,
  ReconnectInterval,
} from "eventsource-parser";
import { z } from "zod/v3";

export const braintrustStreamChunkSchema = z.union([
  z.object({
    type: z.literal("text_delta"),
    data: z.string(),
  }),
  z.object({
    type: z.literal("reasoning_delta"),
    data: z.string(),
  }),
  z.object({
    type: z.literal("json_delta"),
    data: z.string(),
  }),
  z.object({
    type: z.literal("error"),
    data: z.string(),
  }),
  z.object({
    type: z.literal("console"),
    data: sseConsoleEventDataSchema,
  }),
  z.object({
    type: z.literal("progress"),
    data: sseProgressEventDataSchema,
  }),
  z.object({
    type: z.literal("start"),
    data: z.string(),
  }),
  z.object({
    type: z.literal("done"),
    data: z.string(),
  }),
]);

/**
 * A chunk of data from a Braintrust stream. Each chunk type matches
 * an SSE event type.
 */
export type BraintrustStreamChunk = z.infer<typeof braintrustStreamChunkSchema>;

/**
 * A Braintrust stream. This is a wrapper around a ReadableStream of `BraintrustStreamChunk`,
 * with some utility methods to make them easy to log and convert into various formats.
 */
export class BraintrustStream {
  private stream: ReadableStream<BraintrustStreamChunk>;
  private memoizedFinalValue: Promise<unknown> | undefined;
  private signal: AbortSignal | undefined;

  constructor(
    baseStream: ReadableStream<Uint8Array>,
    opts?: { signal?: AbortSignal },
  );
  constructor(stream: ReadableStream<string>, opts?: { signal?: AbortSignal });
  constructor(
    stream: ReadableStream<BraintrustStreamChunk>,
    opts?: { signal?: AbortSignal },
  );
  constructor(
    baseStream:
      | ReadableStream<Uint8Array>
      | ReadableStream<string>
      | ReadableStream<BraintrustStreamChunk>,
    { signal }: { signal?: AbortSignal } = {},
  ) {
    this.signal = signal;
    this.stream = baseStream.pipeThrough(btStreamParser(), { signal });
  }

  /**
   * Copy the stream. This returns a new stream that shares the same underlying
   * stream (via `tee`). Since streams are consumed in Javascript, use `copy()` if you
   * need to use the stream multiple times.
   *
   * @returns A new stream that you can independently consume.
   */
  public copy(): BraintrustStream {
    // Once a stream is tee'd, it is essentially consumed, so we need to replace our own
    // copy of it.
    const [newStream, copyStream] = this.stream.tee();
    this.stream = copyStream;
    return new BraintrustStream(newStream, { signal: this.signal });
  }

  /**
   * Get the underlying ReadableStream.
   *
   * @returns The underlying `ReadableStream<BraintrustStreamChunk>`.
   */
  public toReadableStream(): ReadableStream<BraintrustStreamChunk> {
    return this.stream;
  }

  /**
   * Returns an async iterator for the BraintrustStream.
   * This allows for easy consumption of the stream using a for-await...of loop.
   *
   * @returns An async iterator that yields BraintrustStreamChunk objects.
   */
  [Symbol.asyncIterator](): AsyncIterator<BraintrustStreamChunk> {
    const reader = this.stream.getReader();
    return {
      async next() {
        const { done, value } = await reader.read();
        if (done) {
          reader.releaseLock();
          return { done: true, value: undefined };
        }
        return { done: false, value };
      },
      async return() {
        reader.releaseLock();
        return { done: true, value: undefined };
      },
      async throw(error: unknown) {
        reader.releaseLock();
        throw error;
      },
    };
  }

  /**
   * Get the final value of the stream. The final value is the concatenation of all
   * the chunks in the stream, deserialized into a string or JSON object, depending on
   * the value's type.
   *
   * This function returns a promise that resolves when the stream is closed, and
   * contains the final value. Multiple calls to `finalValue()` will return the same
   * promise, so it is safe to call this multiple times.
   *
   * This function consumes the stream, so if you need to use the stream multiple
   * times, you should call `copy()` first.
   *
   * @returns A promise that resolves with the final value of the stream or `undefined` if the stream is empty.
   */
  public finalValue(): Promise<unknown> {
    if (this.memoizedFinalValue) {
      return this.memoizedFinalValue;
    }
    this.memoizedFinalValue = new Promise((resolve, reject) => {
      this.stream
        .pipeThrough(createFinalValuePassThroughStream(resolve, reject), {
          signal: this.signal,
        })
        .pipeTo(devNullWritableStream(), { signal: this.signal })
        .catch(reject);
    });
    return this.memoizedFinalValue;
  }

  static parseRawEvent(event: CallEventSchema): BraintrustStreamChunk {
    switch (event.event) {
      case "text_delta":
        return {
          type: "text_delta",
          data: JSON.parse(event.data),
        };
      case "reasoning_delta":
        return {
          type: "reasoning_delta",
          data: JSON.parse(event.data),
        };
      case "json_delta":
        return {
          type: "json_delta",
          data: event.data,
        };
      case "error":
        return {
          type: "error",
          data: JSON.parse(event.data),
        };
      case "progress":
        return {
          type: "progress",
          data: sseProgressEventDataSchema.parse(JSON.parse(event.data)),
        };
      case "console":
        return {
          type: "console",
          data: sseConsoleEventDataSchema.parse(JSON.parse(event.data)),
        };
      case "start":
        return {
          type: "start",
          data: "",
        };
      case "done":
        return {
          type: "done",
          data: "",
        };
      default: {
        const _event: never = event;
        throw new Error(`Unknown event type ${JSON.stringify(_event)}`);
      }
    }
  }

  static serializeRawEvent(event: BraintrustStreamChunk): CallEventSchema {
    switch (event.type) {
      case "text_delta":
        return {
          event: "text_delta",
          data: JSON.stringify(event.data),
        };
      case "reasoning_delta":
        return {
          event: "reasoning_delta",
          data: JSON.stringify(event.data),
        };
      case "json_delta":
        return {
          event: "json_delta",
          data: event.data,
        };
      case "error":
        return {
          event: "error",
          data: JSON.stringify(event.data),
        };
      case "progress":
        return {
          event: "progress",
          data: JSON.stringify(event.data),
        };
      case "console":
        return {
          event: "console",
          data: JSON.stringify(event.data),
        };
      case "start":
        return {
          event: "start",
          data: "",
        };
      case "done":
        return {
          event: "done",
          data: "",
        };
      default: {
        const _event: never = event;
        throw new Error(`Unknown event type ${JSON.stringify(_event)}`);
      }
    }
  }
}

function btStreamParser() {
  const decoder = new TextDecoder();
  let parser: EventSourceParser;
  return new TransformStream<
    Uint8Array | string | BraintrustStreamChunk,
    BraintrustStreamChunk
  >({
    async start(controller) {
      parser = createParser((event: ParsedEvent | ReconnectInterval) => {
        if (event.type === "reconnect-interval") {
          return;
        }
        const parsed = callEventSchema.safeParse(event);
        if (!parsed.success) {
          throw new Error(`Failed to parse event: ${parsed.error}`);
        }
        controller.enqueue(BraintrustStream.parseRawEvent(parsed.data));
      });
    },
    async transform(chunk, controller) {
      if (chunk instanceof Uint8Array) {
        parser.feed(decoder.decode(chunk, { stream: true }));
      } else if (typeof chunk === "string") {
        parser.feed(chunk);
      } else {
        controller.enqueue(chunk);
      }
    },
    async flush(controller) {
      const tail = decoder.decode();
      if (tail) {
        parser.feed(tail);
      }
      controller.terminate();
    },
  });
}

/**
 * Create a stream that passes through the final value of the stream. This is
 * used to implement `BraintrustStream.finalValue()`.
 *
 * @param onFinal A function to call with the final value of the stream.
 * @returns A new stream that passes through the final value of the stream.
 */
export function createFinalValuePassThroughStream<
  T extends BraintrustStreamChunk | string | Uint8Array,
>(
  onFinal: (result: unknown) => void,
  onError: (error: unknown) => void,
): TransformStream<T, BraintrustStreamChunk> {
  const decoder = new TextDecoder();
  const textChunks: string[] = [];
  const jsonChunks: string[] = [];
  const reasoningChunks: string[] = [];
  const transformStream = new TransformStream<T, BraintrustStreamChunk>({
    transform(chunk, controller) {
      if (typeof chunk === "string") {
        textChunks.push(chunk);
        controller.enqueue({
          type: "text_delta",
          data: chunk,
        });
      } else if (chunk instanceof Uint8Array) {
        textChunks.push(decoder.decode(chunk));
        controller.enqueue({
          type: "text_delta",
          data: decoder.decode(chunk),
        });
      } else if (braintrustStreamChunkSchema.safeParse(chunk).success) {
        const chunkType = chunk.type;
        switch (chunkType) {
          case "text_delta":
            textChunks.push(chunk.data);
            break;
          case "json_delta":
            jsonChunks.push(chunk.data);
            break;
          case "reasoning_delta":
            reasoningChunks.push(chunk.data);
            break;
          case "error":
            onError(chunk.data);
            break;
          case "progress":
          case "start":
          case "done":
          case "console":
            break;
          default:
            const _type: never = chunkType;
            onError(`Unknown chunk type: ${_type}`);
        }
        controller.enqueue(chunk);
      } else {
        onError(`Unknown chunk type ${JSON.stringify(chunk)}`);
      }
    },
    flush(controller) {
      if (jsonChunks.length > 0) {
        // If we received both text and json deltas in the same stream, we
        // only return the json delta
        onFinal(JSON.parse(jsonChunks.join("")));
      } else if (textChunks.length > 0) {
        onFinal(textChunks.join(""));
      } else if (reasoningChunks.length > 0) {
        onFinal(reasoningChunks.join(""));
      } else {
        onFinal(undefined);
      }

      controller.terminate();
    },
  });

  return transformStream;
}

export function devNullWritableStream(): WritableStream {
  return new WritableStream({
    write(chunk) {},
    close() {},
    abort(reason) {},
    start(controller) {},
  });
}
