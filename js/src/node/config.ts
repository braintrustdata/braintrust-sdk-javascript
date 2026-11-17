import iso from "#braintrust-platform";
import { createNodeIsomorph } from "./platform";

/** @internal Configure source-level tests and compatibility integrations. */
export function configureNode(): void {
  Object.assign(iso, createNodeIsomorph());
}
