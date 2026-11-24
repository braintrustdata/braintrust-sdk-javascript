/* eslint-disable @typescript-eslint/consistent-type-assertions -- vendored SDK methods. */
import { livekitChannels } from "./livekit-interceptors";
import type {
  AgentActivity,
  ModelService,
  ModelWorker,
} from "../../vendor-sdk-types/livekit";

const marker = Symbol.for("braintrust.livekit.modelMethod");

export function wrapLiveKitModelWorker(stream: ModelWorker): void {
  const original = stream.run;
  if (typeof original !== "function" || Reflect.get(original, marker)) return;
  const target = original as (...args: unknown[]) => unknown;
  const fn = function (this: unknown, ...args: unknown[]) {
    return livekitChannels.modelRun.invoke(target, this, args, {});
  };
  Object.defineProperty(fn, marker, { value: true });
  stream.run = fn;
}

/** Observe the producer extension point; never read ahead from the consumer. */
export function wrapLiveKitModelQueue(stream: ModelWorker): boolean {
  const queue = stream.queue;
  const original = queue?.put;
  if (!queue || typeof original !== "function") return false;
  if (Reflect.get(original, marker)) return true;
  const target = original as (value: unknown) => unknown;
  const fn = function (this: unknown, value: unknown) {
    return livekitChannels.modelEnqueue.invoke(target, this, [value], {
      stream,
    });
  };
  Object.defineProperty(fn, marker, { value: true });
  queue.put = fn;
  return true;
}

/** Mechanical wrapping only; both entrypoints invoke the same typed hooks. */
export function wrapLiveKitModels(activity: AgentActivity): void {
  for (const kind of ["llm", "stt", "tts"] as const) {
    const model = activity[kind];
    if (!model) continue;
    for (const method of kind === "llm"
      ? ["chat"]
      : kind === "stt"
        ? ["recognize", "stream"]
        : ["synthesize", "stream"]) {
      const original = model[method];
      if (typeof original !== "function" || Reflect.get(original, marker))
        continue;
      const target = original as (...args: unknown[]) => unknown;
      const fn = function (this: ModelService, ...args: unknown[]) {
        return livekitChannels.model.invoke(target, this, args, {
          kind,
          method,
          activity,
        });
      };
      Object.defineProperty(fn, marker, { value: true });
      model[method] = fn;
    }
  }
}
