import { debugLogger } from "../debug-logger";
import iso from "#braintrust-platform";
import {
  readDisabledInstrumentationEnvConfig,
  type InstrumentationConfig,
  type InstrumentationIntegrationsConfig,
} from "./config";
import { GLOBAL_INSTRUMENTATION_HOOKS_PROTOCOL_VERSION } from "../global-instrumentation-hooks";
import { installGlobalHookErrorReporter } from "../debug-logger";
import { setSpanCustomizers } from "../span-customizer";

export type { InstrumentationConfig } from "./config";

const REGISTRY_KEY = Symbol.for(
  `braintrust.registry.global-hooks.v${GLOBAL_INSTRUMENTATION_HOOKS_PROTOCOL_VERSION}`,
);

type Provider = keyof InstrumentationIntegrationsConfig;
interface RegistryState {
  config: InstrumentationConfig;
  registered: Set<Provider>;
}

// Allocate only on explicit configuration or registration, independently of
// logger state. Multiple SDK copies must agree before either creates a logger.
function getRegistryState(): RegistryState {
  const root = globalThis as typeof globalThis & {
    [REGISTRY_KEY]?: RegistryState;
  };
  return (root[REGISTRY_KEY] ??= { config: {}, registered: new Set() });
}

class InstrumentationRegistry {
  configure(config: InstrumentationConfig): void {
    const state = getRegistryState();
    if (state.registered.size > 0) {
      // eslint-disable-next-line no-restricted-properties -- intentional configuration diagnostic.
      debugLogger.notice.warn(
        "Braintrust: Cannot configure instrumentation after it has been enabled. " +
          "Call configureInstrumentation() before registering instrumentation or wrapping an AI SDK.",
      );
      return;
    }
    if (
      config.streamingAttachmentBufferBytes !== undefined &&
      (!Number.isSafeInteger(config.streamingAttachmentBufferBytes) ||
        config.streamingAttachmentBufferBytes <= 0)
    ) {
      throw new Error(
        "streamingAttachmentBufferBytes must be a positive safe integer",
      );
    }
    if ("spanCustomizers" in config) {
      setSpanCustomizers(config.spanCustomizers);
    }
    state.config = {
      ...state.config,
      ...config,
      integrations: { ...state.config.integrations, ...config.integrations },
    };
  }

  register(
    provider: Provider,
    subscribe: (
      integrations: InstrumentationIntegrationsConfig,
      config: InstrumentationConfig,
    ) => void,
  ): void {
    const state = getRegistryState();
    if (state.registered.has(provider)) return;
    const integrations = {
      ...state.config.integrations,
      ...readDisabledInstrumentationEnvConfig(
        iso.getEnv("BRAINTRUST_DISABLE_INSTRUMENTATION"),
      ).integrations,
    };
    if (
      integrations[provider] === false ||
      (provider === "langchain" && integrations.langgraph === false)
    )
      return;

    installGlobalHookErrorReporter();
    // Stamp before subscribing, so reentrant setup cannot install twice.
    state.registered.add(provider);
    subscribe(integrations, state.config);
  }

  isRegistered(provider: Provider): boolean {
    return getRegistryState().registered.has(provider);
  }

  isEnabled(): boolean {
    return getRegistryState().registered.size > 0;
  }
}

export const registry: InstrumentationRegistry =
  /* @__PURE__ */ new InstrumentationRegistry();

/** Configure consumers before importing braintrust/auto or calling a wrapper. */
export function configureInstrumentation(config: InstrumentationConfig): void {
  registry.configure(config);
}
