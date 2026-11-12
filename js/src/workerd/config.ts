import iso from "#braintrust-platform";
import { createWorkerdIsomorph } from "./platform";

/** @internal Configure source-level tests and compatibility integrations. */
export function configureWorkerd(): void {
  Object.assign(iso, createWorkerdIsomorph());
}
