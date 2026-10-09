import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Encoder } from "./exporter";
import type { EncodedAudio } from "./segment";
const key = Symbol.for("braintrust.audio.workers.v1");
type Pool = {
  running: boolean;
  queue: (() => void)[];
  worker?: Worker;
  idle?: ReturnType<typeof setTimeout>;
};
const pool: Pool = Reflect.get(globalThis, key) ?? {
  running: false,
  queue: [],
};
Reflect.set(globalThis, key, pool);
async function acquire() {
  if (pool.running) {
    if (pool.queue.length >= 1) {
      throw new Error("recording_worker_capacity");
    }
    await new Promise<void>((resolve) => pool.queue.push(resolve));
  } else {
    pool.running = true;
  }
  clearTimeout(pool.idle);
  pool.idle = undefined;
}
function release() {
  const next = pool.queue.shift();
  if (next) {
    next();
  } else {
    pool.running = false;
    const worker = pool.worker;
    if (!worker) {
      return;
    }
    // Reuse nearby work, but do not pin a codec isolate indefinitely after a call.
    worker.unref();
    pool.idle = setTimeout(() => {
      pool.idle = undefined;
      if (pool.worker === worker && !pool.running) {
        pool.worker = undefined;
        void worker.terminate().catch(() => {});
      }
    }, 10000);
    pool.idle.unref();
  }
}
function getWorker() {
  if (!pool.worker) {
    const worker = new Worker(
      join(
        dirname(
          createRequire(__filename).resolve("@braintrust/audio/package.json"),
        ),
        "dist/audio-worker.mjs",
      ),
      // Keep short-lived conversion objects from growing a large nursery in
      // the codec isolate. This does not constrain the application's JS heap.
      {
        env: {},
        execArgv: [],
        resourceLimits: { maxYoungGenerationSizeMb: 2 },
      },
    );
    pool.worker = worker;
    const clear = () => {
      if (pool.worker === worker) {
        pool.worker = undefined;
      }
    };
    // Idle worker failures must neither become unhandled errors nor poison reuse.
    worker.on("error", clear);
    worker.on("exit", clear);
  }
  pool.worker.ref();
  return pool.worker;
}
export function createEncoder(codec?: { module: string }): Encoder {
  return async (packets, durationMs) => {
    await acquire();
    let worker: Worker | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cleanup = () => {};
    try {
      worker = getWorker();
      return await new Promise<EncodedAudio>((resolve, reject) => {
        const message = (result: EncodedAudio & { reason?: string }) =>
          result.reason ? reject(new Error(result.reason)) : resolve(result);
        const error = () => reject(new Error("encoding_failed"));
        const exit = () => reject(new Error("encoder_exit"));
        worker!.once("message", message);
        worker!.once("error", error);
        worker!.once("exit", exit);
        cleanup = () => {
          worker!.off("message", message);
          worker!.off("error", error);
          worker!.off("exit", exit);
        };
        timer = setTimeout(() => reject(new Error("encoder_deadline")), 10000);
        const buffers = [...new Set(packets.map((p) => p.pcm.buffer))].filter(
          (b): b is ArrayBuffer => b instanceof ArrayBuffer,
        );
        worker!.postMessage(
          { packets, durationMs, encoderModule: codec?.module },
          buffers,
        );
      });
    } catch (error) {
      if (pool.worker === worker) {
        pool.worker = undefined;
      }
      // Never reuse a failed/timed-out codec job; keep admission until it stops.
      await worker?.terminate().catch(() => {});
      throw error;
    } finally {
      clearTimeout(timer);
      cleanup();
      release();
    }
  };
}
