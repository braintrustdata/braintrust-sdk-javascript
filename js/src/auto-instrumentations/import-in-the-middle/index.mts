// Unless explicitly stated otherwise all files in this repository are licensed under the Apache 2.0 License.
//
// This product includes software developed at Datadog (https://www.datadoghq.com/). Copyright 2021 Datadog, Inc.

import moduleDetailsFromPath from "module-details-from-path";
import { isBuiltin } from "node:module";
import { fileURLToPath } from "node:url";
import { MessageChannel } from "node:worker_threads";
import registerState, {
  type ImportHook,
  type Namespace,
} from "./lib/register.mjs";

const {
  addHookedModules,
  deleteHookedModules,
  importHooks,
  specifiers,
  toHook,
} = registerState;

export type HookFn = (
  exported: Namespace,
  name: string,
  baseDir?: string,
) => unknown;

interface HookInstance {
  _iitmHook: ImportHook;
  _modules: string[];
}

interface HookConstructor {
  new (modules: unknown, hookFn: unknown): HookInstance;
  (modules: unknown, hookFn: unknown): HookInstance;
  prototype: HookInstance & { unhook(): void };
}

let sendModulesToLoader: ((modules: string[]) => void) | undefined;

function addHook(hook: ImportHook): void {
  importHooks.push(hook);
  toHook.forEach(([name, namespace, specifier]) =>
    hook(name, namespace, specifier),
  );
}

function removeHook(hook: ImportHook): void {
  const index = importHooks.indexOf(hook);
  if (index > -1) {
    importHooks.splice(index, 1);
  }
}

function callHookFn(
  hookFn: HookFn,
  namespace: Namespace,
  name: string,
  baseDir?: string,
): void {
  const newDefault = hookFn(namespace, name, baseDir);
  if (newDefault && newDefault !== namespace && "default" in namespace) {
    namespace.default = newDefault;
  }
}

function normalizeModules(modules: unknown): string[] {
  if (!Array.isArray(modules) || modules.length === 0) {
    throw new TypeError(
      "Braintrust import-in-the-middle requires a non-empty modules array",
    );
  }

  const normalized: string[] = [];
  for (const each of modules) {
    if (typeof each !== "string") {
      throw new TypeError(
        "Braintrust import-in-the-middle only supports string module names or file URLs",
      );
    }
    normalized.push(each);
  }

  return normalized;
}

function moduleMatches(
  matchArg: string,
  name: string,
  filePath: string | undefined,
  specifier: string | undefined,
  baseDir: string | undefined,
  loadUrl: string,
): boolean {
  if (filePath && matchArg === filePath) {
    return true;
  }

  if (matchArg === specifier || matchArg === loadUrl || matchArg === name) {
    return true;
  }

  if (!baseDir) {
    return false;
  }

  // Keep the top-level package check from upstream, but do not support the
  // broad internals mode. Internal files must be listed explicitly.
  return matchArg === name && baseDir.endsWith(String(specifiers.get(loadUrl)));
}

export function createAddHookMessageChannel() {
  const { port1, port2 } = new MessageChannel();
  let pendingAckCount = 0;
  let resolveFn: (() => void) | undefined;

  sendModulesToLoader = (modules: string[]) => {
    pendingAckCount++;
    port1.postMessage(modules);
  };

  port1
    .on("message", () => {
      pendingAckCount--;

      if (resolveFn && pendingAckCount <= 0) {
        resolveFn();
      }
    })
    .unref();

  function waitForAllMessagesAcknowledged(): Promise<void> {
    const timer = setInterval(() => {}, 1000);
    const promise = new Promise<void>((resolve) => {
      resolveFn = resolve;
    }).then(() => {
      clearInterval(timer);
    });

    if (pendingAckCount === 0) {
      resolveFn?.();
    }

    return promise;
  }

  const addHookMessagePort = port2;
  const registerOptions = {
    data: { addHookMessagePort, include: [] as string[] },
    transferList: [addHookMessagePort],
  };

  return {
    registerOptions,
    addHookMessagePort,
    waitForAllMessagesAcknowledged,
  };
}

const Hook: HookConstructor = function (
  this: HookInstance | undefined,
  modules: unknown,
  hookFn: unknown,
): HookInstance | void {
  if (!this || !(this instanceof Hook)) {
    return new Hook(modules, hookFn);
  }

  const normalizedModules = normalizeModules(modules);
  if (typeof hookFn !== "function") {
    throw new TypeError(
      "Braintrust import-in-the-middle requires a hook function",
    );
  }
  const importHookFn = hookFn as HookFn;

  addHookedModules(normalizedModules);
  if (sendModulesToLoader) {
    sendModulesToLoader(normalizedModules);
  }

  this._modules = normalizedModules;
  this._iitmHook = (name, namespace, specifier) => {
    const loadUrl = name;
    let filePath: string | undefined;
    let baseDir: string | undefined;

    if (loadUrl.startsWith("node:")) {
      const unprefixed = name.slice(5);
      if (isBuiltin(unprefixed)) {
        name = unprefixed;
      }
    } else if (loadUrl.startsWith("file://")) {
      const stackTraceLimit = Error.stackTraceLimit;
      Error.stackTraceLimit = 0;
      try {
        filePath = fileURLToPath(name);
        name = filePath;
      } catch {}
      Error.stackTraceLimit = stackTraceLimit;

      if (filePath) {
        const details = moduleDetailsFromPath(filePath);
        if (details) {
          name = details.name;
          baseDir = details.basedir;
        }
      }
    }

    for (const matchArg of normalizedModules) {
      if (
        moduleMatches(matchArg, name, filePath, specifier, baseDir, loadUrl)
      ) {
        callHookFn(
          importHookFn,
          namespace,
          filePath && matchArg === filePath ? filePath : matchArg,
          baseDir,
        );
      }
    }
  };

  addHook(this._iitmHook);
} as HookConstructor;

Hook.prototype.unhook = function (this: HookInstance): void {
  removeHook(this._iitmHook);
  deleteHookedModules(this._modules);
};

export { Hook };
export default Hook;
