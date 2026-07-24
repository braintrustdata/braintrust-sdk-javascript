import * as module from "node:module";
import { createHook, supportsSyncHooks } from "./create-hook.mjs";

export { supportsSyncHooks };

const hook = createHook(import.meta);
type RegisterHooks = (hooks: {
  load: typeof hook.loadSync;
  resolve: typeof hook.resolveSync;
}) => void;

let registered = false;

/**
 * Registers `import-in-the-middle` as a *synchronous*, in-thread loader hook via
 * [`module.registerHooks()`](https://nodejs.org/api/module.html#moduleregisterhooksoptions).
 *
 * Unlike `module.register('import-in-the-middle/hook.mjs', ...)`, which runs the
 * loader on a separate thread and pays an IPC round-trip per resolved module,
 * synchronous hooks run in the application thread. There is no message channel
 * to bridge, so `Hook()` registrations from the main `import-in-the-middle`
 * entry point are visible to the loader directly and no acknowledgement step is
 * required.
 *
 * Requires a Node.js version whose `module.registerHooks` accepts the nullish
 * CommonJS source the loader relies on: >= 22.22.3, >= 24.11.1, >= 25.1.0, or
 * >= 26.0.0 (see `supportsSyncHooks`). Use that predicate to fall back to the
 * asynchronous `module.register` loader on unsupported versions.
 *
 * Braintrust's fork only intercepts modules registered through `Hook([...])`.
 * Call `Hook()` before importing the modules you want to wrap.
 *
 * @returns {void}
 */
export function register() {
  if (!supportsSyncHooks()) {
    throw new Error(
      "'import-in-the-middle' synchronous hooks require a Node.js version whose " +
        "module.registerHooks accepts nullish CommonJS source " +
        "(>= 22.22.3, >= 24.11.1, >= 25.1.0, or >= 26.0.0); " +
        "see https://github.com/nodejs/node/pull/59929",
    );
  }

  if (registered) {
    process.emitWarning(
      "'import-in-the-middle' synchronous hooks have already been registered",
    );
    return;
  }
  registered = true;

  const registerHooks = (
    module as typeof module & {
      registerHooks?: RegisterHooks;
    }
  ).registerHooks;
  if (typeof registerHooks !== "function") {
    throw new Error(
      "'import-in-the-middle' synchronous hooks require module.registerHooks",
    );
  }

  registerHooks({ resolve: hook.resolveSync, load: hook.loadSync });
}
