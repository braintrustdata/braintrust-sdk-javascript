import { createStack } from "./stack";

// Lets the SDK build compressed recordings without depending on this package.
// The SDK loads this package itself; the first copy loaded wins, so duplicate
// installs agree on one implementation.
(globalThis as Record<symbol, unknown>)[Symbol.for("braintrust.audio")] ??= {
  version: 1,
  createStack,
};
