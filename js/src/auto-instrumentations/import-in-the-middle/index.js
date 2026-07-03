// Unless explicitly stated otherwise all files in this repository are licensed under the Apache 2.0 License.
//
// This product includes software developed at Datadog (https://www.datadoghq.com/). Copyright 2021 Datadog, Inc.

const moduleDetailsFromPath = require("module-details-from-path");
const { isBuiltin } = require("module");
const { fileURLToPath } = require("url");
const { MessageChannel } = require("worker_threads");

const {
  addHookedModules,
  deleteHookedModules,
  importHooks,
  specifiers,
  toHook,
} = require("./lib/register");

function addHook(hook) {
  importHooks.push(hook);
  toHook.forEach(([name, namespace, specifier]) =>
    hook(name, namespace, specifier),
  );
}

function removeHook(hook) {
  const index = importHooks.indexOf(hook);
  if (index > -1) {
    importHooks.splice(index, 1);
  }
}

function callHookFn(hookFn, namespace, name, baseDir) {
  const newDefault = hookFn(namespace, name, baseDir);
  if (newDefault && newDefault !== namespace && "default" in namespace) {
    namespace.default = newDefault;
  }
}

function normalizeModules(modules) {
  if (!Array.isArray(modules) || modules.length === 0) {
    throw new TypeError(
      "Braintrust import-in-the-middle requires a non-empty modules array",
    );
  }

  for (const each of modules) {
    if (typeof each !== "string") {
      throw new TypeError(
        "Braintrust import-in-the-middle only supports string module names or file URLs",
      );
    }
  }

  return modules;
}

function moduleMatches(matchArg, name, filePath, specifier, baseDir, loadUrl) {
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
  return matchArg === name && baseDir.endsWith(specifiers.get(loadUrl));
}

let sendModulesToLoader;

function createAddHookMessageChannel() {
  const { port1, port2 } = new MessageChannel();
  let pendingAckCount = 0;
  let resolveFn;

  sendModulesToLoader = (modules) => {
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

  function waitForAllMessagesAcknowledged() {
    const timer = setInterval(() => {}, 1000);
    const promise = new Promise((resolve) => {
      resolveFn = resolve;
    }).then(() => {
      clearInterval(timer);
    });

    if (pendingAckCount === 0) {
      resolveFn();
    }

    return promise;
  }

  const addHookMessagePort = port2;
  const registerOptions = {
    data: { addHookMessagePort, include: [] },
    transferList: [addHookMessagePort],
  };

  return {
    registerOptions,
    addHookMessagePort,
    waitForAllMessagesAcknowledged,
  };
}

function Hook(modules, hookFn) {
  if (this instanceof Hook === false) return new Hook(modules, hookFn);

  modules = normalizeModules(modules);
  if (typeof hookFn !== "function") {
    throw new TypeError(
      "Braintrust import-in-the-middle requires a hook function",
    );
  }

  addHookedModules(modules);
  if (sendModulesToLoader) {
    sendModulesToLoader(modules);
  }

  this._modules = modules;
  this._iitmHook = (name, namespace, specifier) => {
    const loadUrl = name;
    let filePath;
    let baseDir;

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
      } catch (e) {}
      Error.stackTraceLimit = stackTraceLimit;

      if (filePath) {
        const details = moduleDetailsFromPath(filePath);
        if (details) {
          name = details.name;
          baseDir = details.basedir;
        }
      }
    }

    for (const matchArg of modules) {
      if (
        moduleMatches(matchArg, name, filePath, specifier, baseDir, loadUrl)
      ) {
        callHookFn(
          hookFn,
          namespace,
          filePath && matchArg === filePath ? filePath : matchArg,
          baseDir,
        );
      }
    }
  };

  addHook(this._iitmHook);
}

Hook.prototype.unhook = function () {
  removeHook(this._iitmHook);
  deleteHookedModules(this._modules);
};

module.exports = Hook;
module.exports.Hook = Hook;
module.exports.createAddHookMessageChannel = createAddHookMessageChannel;
