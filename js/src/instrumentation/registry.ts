/**
 * Plugin registry and configuration for auto-instrumentation.
 *
 * Plugins are automatically enabled when the Braintrust library is loaded.
 * Users can disable specific integrations programmatically or via environment variables.
 */

import { BraintrustPlugin } from "./braintrust-plugin";
import iso from "../isomorph";
import {
  getDefaultInstrumentationIntegrations,
  readDisabledInstrumentationEnvConfig,
  type InstrumentationConfig,
} from "./config";

export type { InstrumentationConfig } from "./config";

// Key used to stamp the active PluginRegistry instance onto the shared
// braintrust state object (globalThis[Symbol.for("braintrust-state")]).
//
// The braintrust state is already shared across all SDK instances loaded in
// the same process (see _internalSetInitialState in logger.ts), so using it
// as the carrier gives us cross-instance deduplication for free:
//
// - BT-5139 scenario: two SDK instances share the same state object → the
//   second instance sees the marker left by the first and skips subscription,
//   preventing duplicate global hook listeners.
//
// - vi.resetModules() test scenario: the test deletes the state from
//   globalThis between runs, so the next import creates a fresh state with no
//   marker and can subscribe normally.
const REGISTRY_STATE_KEY = Symbol.for("braintrust.registry");

function getSharedState(): Record<symbol, unknown> | undefined {
  const state = (globalThis as Record<symbol, unknown>)[
    Symbol.for("braintrust-state")
  ];
  return state && typeof state === "object"
    ? (state as Record<symbol, unknown>)
    : undefined;
}

class PluginRegistry {
  private braintrustPlugin: BraintrustPlugin | null = null;
  private config: InstrumentationConfig = {};
  private enabled = false;

  /**
   * Configure which integrations should be enabled.
   * This must be called before any SDK imports to take effect.
   */
  configure(config: InstrumentationConfig): void {
    if (this.enabled) {
      // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
      console.warn(
        "Braintrust: Cannot configure instrumentation after it has been enabled. " +
          "Call configureInstrumentation() before importing any AI SDKs.",
      );
      return;
    }
    this.config = { ...this.config, ...config };
  }

  /**
   * Enable all configured plugins.
   * Called automatically when the library is loaded.
   */
  enable(): void {
    if (this.enabled) {
      return;
    }

    // If another SDK instance in the same process already registered plugins,
    // skip to avoid duplicate global hook subscriptions.
    const sharedState = getSharedState();
    if (sharedState) {
      if (sharedState[REGISTRY_STATE_KEY] !== undefined) {
        return;
      }
      sharedState[REGISTRY_STATE_KEY] = this;
    }

    this.enabled = true;

    // Read config from environment variables
    const envConfig = this.readEnvConfig();
    const finalConfig = {
      integrations: {
        ...this.getDefaultConfig(),
        ...this.config.integrations,
        ...envConfig.integrations,
      },
    };

    // Enable BraintrustPlugin with configuration
    this.braintrustPlugin = new BraintrustPlugin(finalConfig);
    this.braintrustPlugin.enable();
  }

  /**
   * Disable all plugins.
   * Primarily used for testing.
   */
  disable(): void {
    if (!this.enabled) {
      return;
    }

    this.enabled = false;

    const sharedState = getSharedState();
    if (sharedState && sharedState[REGISTRY_STATE_KEY] === this) {
      delete sharedState[REGISTRY_STATE_KEY];
    }

    if (this.braintrustPlugin) {
      this.braintrustPlugin.disable();
      this.braintrustPlugin = null;
    }
  }

  /**
   * Check if instrumentation is enabled.
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Get default configuration (all integrations enabled).
   */
  private getDefaultConfig(): Record<string, boolean> {
    return getDefaultInstrumentationIntegrations();
  }

  /**
   * Read configuration from environment variables.
   * Supports: BRAINTRUST_DISABLE_INSTRUMENTATION=openai,anthropic,...
   */
  private readEnvConfig(): InstrumentationConfig {
    return readDisabledInstrumentationEnvConfig(
      iso.getEnv("BRAINTRUST_DISABLE_INSTRUMENTATION"),
    );
  }
}

/**
 * Global plugin registry instance.
 */
export const registry = new PluginRegistry();

/**
 * Configure auto-instrumentation.
 *
 * This must be called before importing any AI SDKs to take effect.
 *
 * @example
 * ```typescript
 * import { configureInstrumentation } from 'braintrust';
 *
 * // Disable OpenAI instrumentation
 * configureInstrumentation({
 *   integrations: { openai: false }
 * });
 *
 * // Now import SDKs
 * import OpenAI from 'openai';
 * ```
 *
 * Environment variables can also be used:
 * ```bash
 * # Disable single SDK
 * BRAINTRUST_DISABLE_INSTRUMENTATION=openai node app.js
 *
 * # Disable multiple SDKs
 * BRAINTRUST_DISABLE_INSTRUMENTATION=openai,anthropic node app.js
 * ```
 */
export function configureInstrumentation(config: InstrumentationConfig): void {
  registry.configure(config);
}
