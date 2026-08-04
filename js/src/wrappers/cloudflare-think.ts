import { cloudflareThinkChannels } from "../instrumentation/plugins/cloudflare-think-channels";
import type {
  CloudflareThinkConstructor,
  CloudflareThinkInstance,
  CloudflareThinkModule,
  CloudflareThinkTurnInput,
} from "../vendor-sdk-types/cloudflare-think";

const WRAPPED_THINK = Symbol.for("braintrust.cloudflare-think.wrapped");

/**
 * Adds Braintrust tracing to an `@cloudflare/think` module when build-time
 * auto-instrumentation is unavailable.
 *
 * @example
 * ```ts
 * import * as cloudflareThink from "@cloudflare/think";
 * import { wrapCloudflareThink } from "braintrust";
 *
 * const { Think } = wrapCloudflareThink(cloudflareThink);
 * ```
 */
export function wrapCloudflareThink<T>(sdk: T): T {
  if (!sdk || typeof sdk !== "object") {
    return sdk;
  }

  const thinkModule = sdk as T & CloudflareThinkModule;
  if (typeof thinkModule.Think !== "function") {
    return sdk;
  }

  patchThinkClass(thinkModule.Think);
  return sdk;
}

function patchThinkClass(Think: CloudflareThinkConstructor): void {
  const prototype = Think.prototype;
  if (!prototype || prototype[WRAPPED_THINK]) {
    return;
  }

  const descriptor = Object.getOwnPropertyDescriptor(
    prototype,
    "_runInferenceLoop",
  );
  if (!descriptor || typeof descriptor.value !== "function") {
    return;
  }

  const original = descriptor.value as NonNullable<
    CloudflareThinkInstance["_runInferenceLoop"]
  >;
  Object.defineProperty(prototype, "_runInferenceLoop", {
    ...descriptor,
    value: function wrappedCloudflareThinkRunInferenceLoop(
      this: CloudflareThinkInstance,
      input: CloudflareThinkTurnInput,
    ) {
      const args = [input] as [CloudflareThinkTurnInput];
      return cloudflareThinkChannels.runInferenceLoop.tracePromise(
        () => Reflect.apply(original, this, args),
        {
          arguments: args,
          self: this,
        },
      );
    },
  });
  Object.defineProperty(prototype, WRAPPED_THINK, {
    configurable: false,
    enumerable: false,
    value: true,
  });
}
