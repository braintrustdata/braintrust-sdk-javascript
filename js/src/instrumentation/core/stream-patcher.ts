/**
 * Utilities for patching async iterables (streams) to collect chunks
 * without modifying the user-facing behavior.
 *
 * This allows global hook subscribers to collect streaming outputs
 * even though they cannot replace return values.
 */

import { debugLogger } from "../../debug-logger";

/**
 * Check if a value is an async iterable (stream).
 */
export function isAsyncIterable(
  value: unknown,
): value is AsyncIterable<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === "function"
  );
}

/**
 * Options for stream patching.
 */
interface StreamPatchOptions<TChunk = unknown, TFinal = unknown> {
  /**
   * Called for each chunk as it's yielded.
   * Optional - if not provided, chunks are just collected.
   */
  onChunk?: (chunk: TChunk) => void | Promise<void>;

  /**
   * Called when the stream completes successfully.
   * Receives all collected chunks.
   */
  onComplete: (chunks: TChunk[]) => TFinal | void | Promise<TFinal | void>;

  /**
   * Called when the consumer cancels the stream before it completes.
   * Falls back to onComplete when omitted.
   */
  onCancel?: (chunks: TChunk[]) => void | Promise<void>;

  /**
   * Called if the stream errors.
   * If not provided, errors are re-thrown after collection stops.
   */
  onError?: (error: Error, chunks: TChunk[]) => void | Promise<void>;

  /**
   * Filter to decide whether to collect a chunk.
   * Return true to collect, false to skip.
   * Default: collect all chunks.
   */
  shouldCollect?: (chunk: TChunk) => boolean;

  /**
   * Optional wrapper around iterator.next(). Used by integrations that need to
   * preserve async context while the producer advances.
   */
  aroundNext?: <T>(callback: () => PromiseLike<T>) => PromiseLike<T> | T;
}

interface ByteStreamObserverOptions {
  aroundRead?: <T>(callback: () => PromiseLike<T>) => PromiseLike<T> | T;
  debugLabel: string;
  onCancel: (error?: unknown) => void;
  onChunk: (chunk: Uint8Array) => void;
  onComplete: () => void;
}

type AsyncIteratorLike<TChunk> = AsyncIterable<TChunk> &
  Partial<AsyncIterator<TChunk>>;

function hasAsyncIteratorMethods<TChunk>(
  value: unknown,
): value is AsyncIteratorLike<TChunk> & {
  next: (...args: [] | [undefined]) => PromiseLike<IteratorResult<TChunk>>;
} {
  return (
    value !== null &&
    typeof value === "object" &&
    "next" in value &&
    typeof (value as { next?: unknown }).next === "function"
  );
}

function isSelfAsyncIterator<TChunk>(
  value: AsyncIteratorLike<TChunk>,
): value is AsyncIteratorLike<TChunk> & {
  next: (...args: [] | [undefined]) => PromiseLike<IteratorResult<TChunk>>;
} {
  try {
    return value[Symbol.asyncIterator]() === value;
  } catch {
    return false;
  }
}

/**
 * Patch an async iterable to collect chunks as they're consumed.
 *
 * This mutates the stream object in-place by wrapping its Symbol.asyncIterator
 * method. The patching is transparent to the user - the stream behaves identically
 * from their perspective.
 *
 * @param stream The async iterable to patch
 * @param options Callbacks for chunk collection and completion
 * @returns The same stream object (mutated), or the original if not patchable
 *
 * @example
 * ```typescript
 * channel.subscribe({
 *   asyncEnd: (event) => {
 *     const { span } = spans.get(event);
 *
 *     patchStreamIfNeeded(event.result, {
 *       onComplete: (chunks) => {
 *         span.log({
 *           output: combineChunks(chunks),
 *           metrics: { chunks: chunks.length }
 *         });
 *         span.end();
 *       },
 *       onError: (error) => {
 *         span.log({ error: error.message });
 *         span.end();
 *       }
 *     });
 *
 *     // For non-streaming, handle here
 *     if (!isAsyncIterable(event.result)) {
 *       span.log({ output: event.result });
 *       span.end();
 *     }
 *   }
 * });
 * ```
 */
export function patchStreamIfNeeded<TChunk = unknown, TFinal = unknown>(
  stream: unknown,
  options: StreamPatchOptions<TChunk, TFinal>,
): unknown {
  // Not an async iterable - nothing to patch
  if (!isAsyncIterable(stream)) {
    return stream;
  }

  // Check if object is extensible (can be patched)
  if (Object.isFrozen(stream) || Object.isSealed(stream)) {
    // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
    console.warn(
      "Cannot patch frozen/sealed stream. Stream output will not be collected.",
    );
    return stream;
  }

  const chunks: TChunk[] = [];
  let completed = false;
  const notifyCancellation = async () => {
    try {
      await (options.onCancel ?? options.onComplete)(chunks);
    } catch (error) {
      debugLogger.error("Error in stream cancellation handler:", error);
    }
  };
  const patchAbortIfPresent = () => {
    try {
      if (
        "abort" in stream &&
        typeof (stream as { abort?: unknown }).abort === "function"
      ) {
        const originalAbort = (
          stream as { abort: (...args: unknown[]) => unknown }
        ).abort.bind(stream);
        (stream as { abort: (...args: unknown[]) => unknown }).abort = (
          ...args
        ) => {
          try {
            return originalAbort(...args);
          } finally {
            if (!completed) {
              completed = true;
              void notifyCancellation();
            }
          }
        };
      }
    } catch (error) {
      debugLogger.warn("Failed to patch stream abort method:", error);
    }
  };

  // Only patch iterator methods directly when the stream is its own iterator.
  // Some SDKs expose a separate iterator from Symbol.asyncIterator(); patching
  // stream.next in those cases is a no-op because consumers never call it.
  if (hasAsyncIteratorMethods<TChunk>(stream) && isSelfAsyncIterator(stream)) {
    if ("__braintrust_patched_iterator_methods" in stream) {
      return stream;
    }

    try {
      const originalNext = stream.next.bind(stream);
      const originalReturn =
        typeof stream.return === "function" ? stream.return.bind(stream) : null;
      const originalThrow =
        typeof stream.throw === "function" ? stream.throw.bind(stream) : null;

      stream.next = async (...args: [] | [undefined]) => {
        try {
          const result = await runNextWithWrapper(options, () =>
            originalNext(...args),
          );

          if (result.done) {
            if (!completed) {
              completed = true;
              try {
                await options.onComplete(chunks);
              } catch (error) {
                // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
                console.error("Error in stream onComplete handler:", error);
              }
            }
          } else {
            const chunk = result.value as TChunk;
            const shouldCollect = options.shouldCollect
              ? options.shouldCollect(chunk)
              : true;

            if (shouldCollect) {
              chunks.push(chunk);

              if (options.onChunk) {
                try {
                  await options.onChunk(chunk);
                } catch (error) {
                  // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
                  console.error("Error in stream onChunk handler:", error);
                }
              }
            }
          }

          return result;
        } catch (error) {
          if (!completed) {
            completed = true;
            if (options.onError) {
              try {
                await options.onError(
                  error instanceof Error ? error : new Error(String(error)),
                  chunks,
                );
              } catch (handlerError) {
                // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
                console.error("Error in stream onError handler:", handlerError);
              }
            }
          }
          throw error;
        }
      };

      if (originalReturn) {
        stream.return = async (...args: [unknown?]) => {
          if (!completed) {
            completed = true;
            await notifyCancellation();
          }
          return originalReturn(...args);
        };
      }

      if (originalThrow) {
        stream.throw = async (...args: [unknown?]) => {
          if (!completed) {
            completed = true;
            const rawError: unknown = args[0];
            const error =
              rawError instanceof Error
                ? rawError
                : new Error(String(rawError));
            if (options.onError) {
              try {
                await options.onError(error, chunks);
              } catch (handlerError) {
                // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
                console.error("Error in stream onError handler:", handlerError);
              }
            }
          }
          return originalThrow(...args);
        };
      }

      Object.defineProperty(stream, "__braintrust_patched_iterator_methods", {
        value: true,
      });

      patchAbortIfPresent();
      return stream;
    } catch (error) {
      // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
      console.warn("Failed to patch stream iterator methods:", error);
    }
  }

  const originalIteratorFn = stream[Symbol.asyncIterator];

  // Check if already patched (avoid double-patching)
  if (
    "__braintrust_patched" in originalIteratorFn &&
    originalIteratorFn["__braintrust_patched"]
  ) {
    return stream;
  }

  try {
    // Create patched iterator function
    const patchedIteratorFn = function (this: any) {
      const iterator = originalIteratorFn.call(this);
      const originalNext = iterator.next.bind(iterator);

      // Patch the next() method
      iterator.next = async function (...args: [] | [undefined]) {
        try {
          const result = await runNextWithWrapper(options, () =>
            originalNext(...args),
          );

          if (result.done) {
            // Stream completed successfully
            if (!completed) {
              completed = true;
              try {
                await options.onComplete(chunks);
              } catch (error) {
                // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
                console.error("Error in stream onComplete handler:", error);
              }
            }
          } else {
            // Got a chunk
            const chunk = result.value as TChunk;

            // Check if we should collect this chunk
            const shouldCollect = options.shouldCollect
              ? options.shouldCollect(chunk)
              : true;

            if (shouldCollect) {
              chunks.push(chunk);

              // Call onChunk handler if provided
              if (options.onChunk) {
                try {
                  await options.onChunk(chunk);
                } catch (error) {
                  // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
                  console.error("Error in stream onChunk handler:", error);
                }
              }
            }
          }

          return result;
        } catch (error) {
          // Stream errored
          if (!completed) {
            completed = true;
            if (options.onError) {
              try {
                await options.onError(
                  error instanceof Error ? error : new Error(String(error)),
                  chunks,
                );
              } catch (handlerError) {
                // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
                console.error("Error in stream onError handler:", handlerError);
              }
            }
          }
          throw error;
        }
      };

      // Patch return() if it exists (cleanup method)
      if (iterator.return) {
        const originalReturn = iterator.return.bind(iterator);
        iterator.return = async function (...args: any[]) {
          if (!completed) {
            completed = true;
            await notifyCancellation();
          }
          return originalReturn(...args);
        };
      }

      // Patch throw() if it exists (error injection method)
      if (iterator.throw) {
        const originalThrow = iterator.throw.bind(iterator);
        iterator.throw = async function (...args: any[]) {
          if (!completed) {
            completed = true;
            const rawError: unknown = args[0];
            const error =
              rawError instanceof Error
                ? rawError
                : new Error(String(rawError));
            if (options.onError) {
              try {
                await options.onError(error, chunks);
              } catch (handlerError) {
                // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
                console.error("Error in stream onError handler:", handlerError);
              }
            }
          }
          return originalThrow(...args);
        };
      }

      return iterator;
    };

    // Mark as patched to avoid double-patching
    Object.defineProperty(patchedIteratorFn, "__braintrust_patched", {
      value: true,
    });

    // Replace the Symbol.asyncIterator method
    (stream as any)[Symbol.asyncIterator] = patchedIteratorFn;

    patchAbortIfPresent();
    return stream;
  } catch (error) {
    // If patching fails for any reason, log warning and return original
    // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
    console.warn("Failed to patch stream:", error);
    return stream;
  }
}

/** Observe reads in place without draining or teeing a one-shot byte stream. */
export function observeByteStream(
  value: unknown,
  options: ByteStreamObserverOptions,
): void {
  let ended = false;
  const safeObserve = (chunk: Uint8Array) => {
    if (ended) return;
    try {
      options.onChunk(chunk);
    } catch (error) {
      debugLogger.error(`Error collecting ${options.debugLabel}`, error);
      end(false);
    }
  };
  const end = (success: boolean, error?: unknown) => {
    if (ended) return;
    ended = true;
    try {
      if (success) options.onComplete();
      else options.onCancel(error);
    } catch (loggingError) {
      debugLogger.error(`Error logging ${options.debugLabel}`, loggingError);
      options.onCancel();
    }
  };
  if (
    value === null ||
    typeof value !== "object" ||
    !Object.isExtensible(value)
  ) {
    end(false);
    return;
  }
  // node-fetch returns a Node Readable. Observing data emission does not put
  // it into flowing mode, and snapshots bytes before application listeners run.
  if (
    "read" in value &&
    typeof value.read === "function" &&
    "on" in value &&
    typeof value.on === "function"
  ) {
    value.on("end", () => end(true));
    value.on("close", () => end(false));
    const emit =
      "emit" in value ? (value as { emit?: unknown }).emit : undefined;
    if (typeof emit === "function")
      (value as { emit?: unknown }).emit = function (
        event: string | symbol,
        ...args: unknown[]
      ) {
        if (event === "data" && args[0] instanceof Uint8Array)
          safeObserve(args[0]);
        if (event === "error") end(false, args[0]);
        return Reflect.apply(emit, this, [event, ...args]);
      };
    return;
  }
  if ("getReader" in value && typeof value.getReader === "function") {
    const webStream = value as unknown as ReadableStream<Uint8Array>;
    const pipeTo = webStream.pipeTo;
    const pipeThrough = webStream.pipeThrough;
    // Native piping bypasses getReader()/iteration. Add the observation only
    // when the application starts piping, preserving downstream backpressure.
    webStream.pipeTo = function (destination, streamOptions) {
      if (
        destination === null ||
        typeof destination !== "object" ||
        this.locked ||
        destination.locked
      )
        return pipeTo.call(this, destination, streamOptions);
      const tap = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          safeObserve(chunk);
          controller.enqueue(chunk);
        },
        flush() {
          end(true);
        },
      });
      const observed = pipeThrough.call(
        this,
        tap,
        streamOptions,
      ) as ReadableStream<Uint8Array>;
      return observed.pipeTo(destination, streamOptions).catch((error) => {
        end(false, error);
        throw error;
      });
    };
    webStream.pipeThrough = function <T>(
      transform: ReadableWritablePair<T, Uint8Array>,
      streamOptions?: StreamPipeOptions,
    ): ReadableStream<T> {
      if (this.locked || transform.writable.locked || transform.readable.locked)
        return pipeThrough.call(
          this,
          transform,
          streamOptions,
        ) as ReadableStream<T>;
      const result = webStream.pipeTo.call(
        this,
        transform.writable,
        streamOptions,
      );
      // pipeThrough marks its internal pipe promise handled, just like the
      // native implementation. Errors still propagate through the transform.
      void result.catch(() => {});
      return transform.readable;
    };
    const getReader = value.getReader;
    value.getReader = function (...args: unknown[]) {
      const reader = Reflect.apply(getReader, this, args);
      const read = reader.read as (
        ...args: unknown[]
      ) => Promise<ReadableStreamReadResult<Uint8Array>>;
      reader.read = function (...readArgs: unknown[]) {
        const readValue = () => Reflect.apply(read, this, readArgs);
        return Promise.resolve(
          options.aroundRead ? options.aroundRead(readValue) : readValue(),
        ).then(
          (result: ReadableStreamReadResult<Uint8Array>) => {
            if (result.value) safeObserve(result.value);
            if (result.done) end(true);
            return result;
          },
          (error: unknown) => {
            end(false, error);
            throw error;
          },
        );
      };
      const readerCancel = reader.cancel;
      reader.cancel = function (...cancelArgs: unknown[]) {
        const result = Reflect.apply(readerCancel, this, cancelArgs);
        end(false);
        return result;
      };
      return reader;
    };
    const streamCancel = (value as { cancel?: unknown }).cancel;
    if (typeof streamCancel === "function")
      (value as unknown as { cancel: (...args: unknown[]) => unknown }).cancel =
        function (...args: unknown[]) {
          const result = Reflect.apply(streamCancel, this, args);
          void Promise.resolve(result).then(
            () => end(false),
            () => {},
          );
          return result;
        };
  }
  if (
    "getReader" in value &&
    typeof value.getReader === "function" &&
    "values" in value &&
    typeof value.values === "function"
  ) {
    const values = value.values;
    const iterate = function (this: unknown, ...args: unknown[]) {
      const iterator = Reflect.apply(values, this, args);
      patchStreamIfNeeded<Uint8Array>(iterator, {
        shouldCollect(chunk) {
          safeObserve(chunk);
          return false;
        },
        onComplete: () => end(true),
        onCancel: () => end(false),
        onError: (error) => end(false, error),
        aroundNext: options.aroundRead,
      });
      return iterator;
    };
    value.values = iterate;
    Object.defineProperty(value, Symbol.asyncIterator, {
      configurable: true,
      writable: true,
      value: iterate,
    });
  } else if (isAsyncIterable(value)) {
    patchStreamIfNeeded<Uint8Array>(value, {
      shouldCollect: (chunk) => {
        safeObserve(chunk);
        return false;
      },
      onComplete: () => end(true),
      onCancel: () => end(false),
      onError: (error) => end(false, error),
      aroundNext: options.aroundRead,
    });
  } else if (!("getReader" in value) || typeof value.getReader !== "function")
    end(false);
}

function runNextWithWrapper<T, TChunk, TFinal>(
  options: StreamPatchOptions<TChunk, TFinal>,
  callback: () => PromiseLike<T>,
): PromiseLike<T> | T {
  return options.aroundNext ? options.aroundNext(callback) : callback();
}

/**
 * Higher-level helper for common pattern: collect chunks and process on completion.
 *
 * This is a convenience wrapper around patchStreamIfNeeded that handles the
 * common case of collecting chunks, processing them, and calling a callback.
 *
 * @example
 * ```typescript
 * wrapStreamResult(event.result, {
 *   processChunks: (chunks) => ({
 *     output: chunks.map(c => c.delta.content).join(''),
 *     metrics: { chunks: chunks.length }
 *   }),
 *   onResult: (processed) => {
 *     span.log(processed);
 *     span.end();
 *   },
 *   onNonStream: (result) => {
 *     span.log({ output: result });
 *     span.end();
 *   }
 * });
 * ```
 */
export function wrapStreamResult<TChunk = unknown, TProcessed = unknown>(
  result: unknown,
  options: {
    /**
     * Process collected chunks into final result.
     * Called when stream completes.
     */
    processChunks: (chunks: TChunk[]) => TProcessed;

    /**
     * Called with processed result (for streams) or original result (for non-streams).
     */
    onResult: (processed: TProcessed | unknown) => void;

    /**
     * Optional handler for non-stream results.
     * If not provided, onResult is called directly with the result.
     */
    onNonStream?: (result: unknown) => TProcessed | unknown;

    /**
     * Optional error handler.
     */
    onError?: (error: Error, chunks: TChunk[]) => void;

    /**
     * Optional filter for chunks.
     */
    shouldCollect?: (chunk: TChunk) => boolean;
  },
): unknown {
  if (isAsyncIterable(result)) {
    // Patch the stream
    return patchStreamIfNeeded<TChunk, TProcessed>(result, {
      onComplete: (chunks) => {
        try {
          const processed = options.processChunks(chunks);
          options.onResult(processed);
        } catch (error) {
          // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
          console.error("Error processing stream chunks:", error);
          if (options.onError) {
            options.onError(
              error instanceof Error ? error : new Error(String(error)),
              chunks,
            );
          }
        }
      },
      onError: options.onError,
      shouldCollect: options.shouldCollect,
    });
  } else {
    // Not a stream - process directly
    try {
      const processed = options.onNonStream
        ? options.onNonStream(result)
        : result;
      options.onResult(processed);
    } catch (error) {
      // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
      console.error("Error processing non-stream result:", error);
      if (options.onError) {
        options.onError(
          error instanceof Error ? error : new Error(String(error)),
          [],
        );
      }
    }
    return result;
  }
}
