import iso from "#braintrust-platform";
import { createBrowserIsomorph } from "./platform";

/** @internal Configure source-level tests and compatibility integrations. */
export function configureBrowser(): void {
  Object.assign(iso, createBrowserIsomorph());
}
