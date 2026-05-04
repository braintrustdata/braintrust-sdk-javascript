import { openAICodexChannels } from "../instrumentation/plugins/openai-codex-channels";
import type {
  OpenAICodexClass,
  OpenAICodexClient,
  OpenAICodexInput,
  OpenAICodexSDKModule,
  OpenAICodexStreamedTurn,
  OpenAICodexThread,
  OpenAICodexThreadOptions,
  OpenAICodexTurn,
  OpenAICodexTurnOptions,
} from "../vendor-sdk-types/openai-codex";

const WRAPPED_CLIENT = Symbol.for("braintrust.openai-codex.wrapped-client");
const WRAPPED_THREAD = Symbol.for("braintrust.openai-codex.wrapped-thread");

/**
 * Wraps the OpenAI Codex TypeScript SDK with Braintrust tracing. The wrapper
 * emits diagnostics-channel events; the OpenAI Codex plugin owns span lifecycle.
 */
export function wrapOpenAICodexSDK<T>(sdk: T): T {
  if (!sdk || typeof sdk !== "object") {
    return sdk;
  }

  const maybeSDK = sdk as Record<PropertyKey, unknown>;
  if (hasCodexClientShape(maybeSDK)) {
    return wrapCodexClient(maybeSDK as unknown as OpenAICodexClient) as T;
  }

  if (!maybeSDK.Codex || typeof maybeSDK.Codex !== "function") {
    // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
    console.warn("Unsupported OpenAI Codex SDK. Not wrapping.");
    return sdk;
  }

  const target = isModuleNamespace(sdk)
    ? Object.setPrototypeOf({}, sdk)
    : (sdk as Record<PropertyKey, unknown>);

  return new Proxy(target, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === "Codex" && typeof value === "function") {
        return wrapCodexClass(value as unknown as OpenAICodexClass);
      }
      if (typeof value === "function") {
        return value.bind(target);
      }
      return value;
    },
  }) as T;
}

function hasCodexClientShape(value: Record<PropertyKey, unknown>): boolean {
  return (
    typeof value.startThread === "function" &&
    typeof value.resumeThread === "function"
  );
}

function isModuleNamespace(obj: unknown): boolean {
  if (!obj || typeof obj !== "object") {
    return false;
  }
  if (obj.constructor?.name === "Module") {
    return true;
  }
  const keys = Object.keys(obj);
  if (keys.length === 0) {
    return false;
  }
  const descriptor = Object.getOwnPropertyDescriptor(obj, keys[0]);
  return descriptor ? !descriptor.configurable && !descriptor.writable : false;
}

function wrapCodexClass(Codex: OpenAICodexClass): OpenAICodexClass {
  return new Proxy(Codex, {
    construct(target, args, newTarget) {
      return wrapCodexClient(Reflect.construct(target, args, newTarget));
    },
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") {
        return value.bind(target);
      }
      return value;
    },
  }) as OpenAICodexClass;
}

function wrapCodexClient(client: OpenAICodexClient): OpenAICodexClient {
  if (!client || typeof client !== "object") {
    return client;
  }
  if ((client as unknown as Record<PropertyKey, unknown>)[WRAPPED_CLIENT]) {
    return client;
  }

  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === WRAPPED_CLIENT) {
        return true;
      }

      const value = Reflect.get(target, prop, receiver);
      if (prop === "startThread" && typeof value === "function") {
        return function (options?: OpenAICodexThreadOptions) {
          return wrapCodexThread(Reflect.apply(value, target, [options]));
        };
      }
      if (prop === "resumeThread" && typeof value === "function") {
        return function (id: string, options?: OpenAICodexThreadOptions) {
          return wrapCodexThread(Reflect.apply(value, target, [id, options]));
        };
      }
      if (typeof value === "function") {
        return value.bind(target);
      }
      return value;
    },
  });
}

function wrapCodexThread(thread: OpenAICodexThread): OpenAICodexThread {
  if (!thread || typeof thread !== "object") {
    return thread;
  }
  if ((thread as unknown as Record<PropertyKey, unknown>)[WRAPPED_THREAD]) {
    return thread;
  }

  return new Proxy(thread, {
    get(target, prop, receiver) {
      if (prop === WRAPPED_THREAD) {
        return true;
      }

      const value = Reflect.get(target, prop, receiver);
      if (prop === "run" && typeof value === "function") {
        return function (
          input: OpenAICodexInput,
          turnOptions?: OpenAICodexTurnOptions,
        ): Promise<OpenAICodexTurn> {
          const args = [input, turnOptions] as [
            OpenAICodexInput,
            OpenAICodexTurnOptions | undefined,
          ];
          return openAICodexChannels.run.tracePromise(
            () => Reflect.apply(value, target, args),
            {
              arguments: args,
              operation: "run",
              thread: target,
            } as never,
          );
        };
      }
      if (prop === "runStreamed" && typeof value === "function") {
        return function (
          input: OpenAICodexInput,
          turnOptions?: OpenAICodexTurnOptions,
        ): Promise<OpenAICodexStreamedTurn> {
          const args = [input, turnOptions] as [
            OpenAICodexInput,
            OpenAICodexTurnOptions | undefined,
          ];
          return openAICodexChannels.runStreamed.tracePromise(
            () => Reflect.apply(value, target, args),
            {
              arguments: args,
              operation: "runStreamed",
              thread: target,
            } as never,
          );
        };
      }
      if (typeof value === "function") {
        return value.bind(target);
      }
      return value;
    },
  });
}

export type { OpenAICodexSDKModule };
