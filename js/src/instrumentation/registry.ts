/**
 * Plugin registry and configuration for auto-instrumentation.
 *
 * Plugins are automatically enabled when the Braintrust library is loaded.
 * Users can disable specific integrations programmatically or via environment variables.
 */

import { BraintrustPlugin } from "./braintrust-plugin";
import iso from "../isomorph";

export interface InstrumentationConfig {
  /**
   * Configuration for individual SDK integrations.
   * Set to false to disable instrumentation for that SDK.
   */
  integrations?: {
    openai?: boolean;
    anthropic?: boolean;
    vercel?: boolean;
    aisdk?: boolean;
    google?: boolean;
    claudeAgentSDK?: boolean;
    openrouter?: boolean;
  };
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
    return {
      openai: true,
      anthropic: true,
      vercel: true,
      aisdk: true,
      google: true,
      claudeAgentSDK: true,
      openrouter: true,
    };
  }

  /**
   * Read configuration from environment variables.
   * Supports: BRAINTRUST_DISABLE_INSTRUMENTATION=openai,anthropic,...
   */
  private readEnvConfig(): InstrumentationConfig {
    const integrations: Record<string, boolean> = {};

    const disabledList = iso.getEnv("BRAINTRUST_DISABLE_INSTRUMENTATION");
    if (disabledList) {
      const disabled = disabledList
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0);

      for (const sdk of disabled) {
        integrations[sdk] = false;
      }
    }

    return { integrations };
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
