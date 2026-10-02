export abstract class BasePlugin {
  protected enabled = false;
  protected unsubscribers: Array<() => void> = [];

  /**
   * Enables the plugin. Registers the plugin’s invocation interceptors.
   */
  enable(): void {
    if (this.enabled) {
      return;
    }
    this.enabled = true;
    this.onEnable();
  }

  /**
   * Disables the plugin. Removes the plugin’s invocation interceptors.
   */
  disable(): void {
    if (!this.enabled) {
      return;
    }
    this.enabled = false;
    this.onDisable();
  }

  /**
   * Called when the plugin is enabled.
   * Override this to register interceptors.
   */
  protected abstract onEnable(): void;

  /**
   * Called when the plugin is disabled.
   * Override this to remove interceptors.
   */
  protected abstract onDisable(): void;
}
