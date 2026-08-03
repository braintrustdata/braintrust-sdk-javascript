import type { VitePlugin } from "unplugin";
import { BundlerPluginOptions, unplugin } from "./plugin";
export type { InstrumentationConfig } from "../orchestrion-js";

export function braintrustVitePlugin(
  options: BundlerPluginOptions = {},
): VitePlugin | VitePlugin[] {
  const transformPlugin = unplugin.vite(options);
  const optimizeDepsPlugin: VitePlugin = {
    name: "braintrust:optimize-deps",
    config() {
      return {
        optimizeDeps: {
          esbuildOptions: {
            plugins: [unplugin.esbuild(options)],
          },
        },
      };
    },
    configEnvironment(name: string) {
      // The client environment inherits the root optimizer config above.
      // Custom environments (including Cloudflare Workers) maintain their own
      // dependency optimizer and need the transformer registered explicitly.
      if (name === "client") {
        return;
      }
      return {
        optimizeDeps: {
          esbuildOptions: {
            plugins: [unplugin.esbuild(options)],
          },
        },
      };
    },
  };

  return [
    optimizeDepsPlugin,
    ...(Array.isArray(transformPlugin) ? transformPlugin : [transformPlugin]),
  ];
}

export type VitePluginOptions = BundlerPluginOptions;

/**
 * @deprecated Use {@link braintrustVitePlugin} instead.
 */
export const vitePlugin = unplugin.vite;
