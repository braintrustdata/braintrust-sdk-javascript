import iso from "#braintrust-platform";
import { createEdgeLightIsomorph } from "./platform";

/** @internal Configure source-level tests and compatibility integrations. */
export function configureEdgeLight(): void {
  Object.assign(iso, createEdgeLightIsomorph());
}
