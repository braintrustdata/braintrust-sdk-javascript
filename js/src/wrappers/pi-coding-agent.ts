import { piCodingAgentChannels } from "../instrumentation/plugins/pi-coding-agent-channels";
import type {
  PiAgentSession,
  PiAgentSessionClass,
  PiCodingAgentModule,
  PiPromptOptions,
} from "../vendor-sdk-types/pi-coding-agent";

const WRAPPED_PROMPT = Symbol.for("braintrust.pi-coding-agent.wrapped-prompt");

/**
 * Wraps the Pi Coding Agent SDK with Braintrust tracing. The wrapper emits
 * diagnostics-channel events; the Pi Coding Agent plugin owns span lifecycle.
 */
export function wrapPiCodingAgentSDK<T>(sdk: T): T {
  if (!sdk || typeof sdk !== "object") {
    return sdk;
  }

  const maybeSDK = sdk as Record<PropertyKey, unknown>;
  if (!maybeSDK.AgentSession || typeof maybeSDK.AgentSession !== "function") {
    // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
    console.warn("Unsupported Pi Coding Agent SDK. Not wrapping.");
    return sdk;
  }

  patchAgentSessionClass(
    maybeSDK.AgentSession as unknown as PiAgentSessionClass,
  );
  return sdk as T & PiCodingAgentModule;
}

function patchAgentSessionClass(AgentSession: PiAgentSessionClass): void {
  const prototype = AgentSession.prototype as PiAgentSession &
    Record<PropertyKey, unknown>;
  if (!prototype || prototype[WRAPPED_PROMPT]) {
    return;
  }

  const descriptor = Object.getOwnPropertyDescriptor(prototype, "prompt");
  if (!descriptor || typeof descriptor.value !== "function") {
    // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
    console.warn("Unsupported Pi Coding Agent SDK. Not wrapping.");
    return;
  }

  const originalPrompt = descriptor.value as PiAgentSession["prompt"];
  Object.defineProperty(prototype, "prompt", {
    ...descriptor,
    value: function wrappedPiCodingAgentPrompt(
      this: PiAgentSession,
      text: string,
      options?: PiPromptOptions,
    ) {
      const args = [text, options] as [string, PiPromptOptions | undefined];
      return piCodingAgentChannels.prompt.tracePromise(
        () => Reflect.apply(originalPrompt, this, args),
        {
          arguments: args,
          self: this,
          session: this,
        },
      );
    },
  });

  Object.defineProperty(prototype, WRAPPED_PROMPT, {
    configurable: false,
    enumerable: false,
    value: true,
  });
}

export type { PiCodingAgentModule };
