import { registerCursorSDKInstrumentation } from "../providers/cursor-sdk-instrumentation";
import { registry } from "../registry";

/** Enable this provider once across compatible SDK copies. */
export function registerInstrumentation(): void {
  registry.register("cursorSDK", () => {
    registerCursorSDKInstrumentation();
  });
}
