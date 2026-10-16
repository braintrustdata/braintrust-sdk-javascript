import { observe } from "./runtime";

/** Observe consumed objects without teeing, prefetching, or touching audio. */
export function observeStream<T>(
  stream: ReadableStream<T>,
  value: (value: T) => void,
  done: () => void = () => {},
): ReadableStream<T> {
  let reader: ReadableStreamDefaultReader<T> | undefined;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    observe(done);
  };
  return new ReadableStream<T>(
    {
      async pull(controller) {
        reader ??= stream.getReader();
        try {
          const result = await reader.read();
          if (result.done) {
            finish();
            reader.releaseLock();
            controller.close();
          } else {
            observe(() => value(result.value));
            controller.enqueue(result.value);
          }
        } catch (error) {
          finish();
          reader.releaseLock();
          controller.error(error);
        }
      },
      async cancel(reason) {
        try {
          if (reader) await reader.cancel(reason);
          else await stream.cancel(reason);
        } finally {
          finish();
          reader?.releaseLock();
        }
      },
    },
    { highWaterMark: 0 },
  );
}
