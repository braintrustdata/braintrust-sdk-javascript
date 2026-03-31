import { mustachePlugin } from "./plugins/mustache";

export type TemplateFormat = "mustache" | "nunjucks" | "none";

export interface TemplateRenderer {
  render: (
    template: string,
    variables: Record<string, unknown>,
    escape: (v: unknown) => string,
    strict: boolean,
  ) => string;
  lint?: (template: string, variables: Record<string, unknown>) => void;
}

/**
 * A template renderer plugin that can be registered with Braintrust.
 *
 * Plugins provide support for different template engines (e.g., Nunjucks).
 * They use a factory pattern where the plugin is registered once, then activated with specific
 * configuration options when needed.
 *
 * @example
 * ```typescript
 * import type { TemplateRendererPlugin } from "braintrust";
 *
 * export const myPlugin: TemplateRendererPlugin = {
 *   name: "my-template-engine",
 *   version: "1.0.0",
 *   defaultOptions: { strict: false },
 *   createRenderer(options?: unknown) {
 *     const opts = options ?? this.defaultOptions;
 *     return {
 *       render(template, variables, escape, strict) {
 *         // Your rendering logic here
 *       }
 *     };
 *   }
 * };
 * ```
 */
export interface TemplateRendererPlugin {
  /**
   * Unique identifier for this plugin.
   * Must match the format string used in `templateFormat` option.
   */
  name: string;

  /**
   * Factory function that creates a renderer instance.
   *
   * @param options - If not provided, `defaultOptions` is used.
   * @returns A configured TemplateRenderer instance
   */
  createRenderer: () => TemplateRenderer;

  /**
   * Default configuration options for this plugin.
   */
  defaultOptions?: unknown;
}

class TemplatePluginRegistry {
  private plugins = new Map<
    string,
    { plugin: TemplateRendererPlugin; renderer?: TemplateRenderer }
  >();

  register(plugin: TemplateRendererPlugin): void {
    if (this.plugins.has(plugin.name)) {
      // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
      console.warn(
        `Template plugin '${plugin.name}' already registered, overwriting`,
      );
    }

    const entry = {
      plugin,
      renderer:
        plugin.defaultOptions !== undefined
          ? plugin.createRenderer()
          : undefined,
    };

    this.plugins.set(plugin.name, entry);
  }

  getAvailable(): string[] {
    return Array.from(this.plugins.keys());
  }

  get(name: string): TemplateRenderer | undefined {
    return this.plugins.get(name)?.renderer;
  }

  isRegistered(name: string): boolean {
    return this.plugins.has(name);
  }
}

export const templateRegistry = new TemplatePluginRegistry();

/**
 * Register a template plugin and optionally activate it
 *
 * If `options` is provided it will be used to create the active renderer.
 * If `options` is omitted but the plugin defines `defaultOptions`, the
 * registry will activate the renderer using those defaults.
 */
export const registerTemplatePlugin =
  templateRegistry.register.bind(templateRegistry);

/**
 * Gets an active template renderer by name.
 *
 * Returns `undefined` if the renderer is not active.
 *
 * @param name - Name of the renderer to retrieve
 * @returns The active renderer, or undefined if not activated
 *
 * @example
 * ```typescript
 * import { getTemplateRenderer } from "braintrust";
 *
 * const renderer = getTemplateRenderer("nunjucks");
 * if (renderer) {
 *   const output = renderer.render(template, variables, escape, strict);
 * }
 * ```
 */
export const getTemplateRenderer = templateRegistry.get.bind(templateRegistry);

registerTemplatePlugin(mustachePlugin);
