/**
 * Utilities for patching async iterables (streams) to collect chunks
 * without modifying the user-facing behavior.
 *
 * This allows diagnostics channel subscribers to collect streaming outputs
 * even though they cannot replace return values.
 */

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
export interface StreamPatchOptions<TChunk = unknown, TFinal = unknown> {
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
      const chunks: TChunk[] = [];
      let completed = false;

      stream.next = async (...args: [] | [undefined]) => {
        try {
          const result = await originalNext(...args);

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
            try {
              await options.onComplete(chunks);
            } catch (error) {
              // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
              console.error("Error in stream onComplete handler:", error);
            }
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
      const chunks: TChunk[] = [];
      let completed = false;

      // Patch the next() method
      iterator.next = async function (...args: [] | [undefined]) {
        try {
          const result = await originalNext(...args);

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
            // Stream was cancelled/returned early
            try {
              await options.onComplete(chunks);
            } catch (error) {
              // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
              console.error("Error in stream onComplete handler:", error);
            }
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

    return stream;
  } catch (error) {
    // If patching fails for any reason, log warning and return original
    // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
    console.warn("Failed to patch stream:", error);
    return stream;
  }
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
