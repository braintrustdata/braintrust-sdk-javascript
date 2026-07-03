"use strict";

const path = require("path");
const Module = require("module");
const moduleDetailsFromPath = require("module-details-from-path");

module.exports = Hook;
module.exports.Hook = Hook;

let builtinModules;

let isCore;
if (Module.isBuiltin) {
  isCore = Module.isBuiltin;
} else if (Module.builtinModules) {
  isCore = (moduleName) => {
    if (moduleName.startsWith("node:")) {
      return true;
    }

    if (builtinModules === undefined) {
      builtinModules = new Set(Module.builtinModules);
    }

    return builtinModules.has(moduleName);
  };
} else {
  throw new Error(
    "Braintrust require-in-the-middle requires Node.js >=v9.3.0 or >=v8.10.0",
  );
}

const normalize = /([/\\]index)?(\.js|\.cjs)?$/;

class ExportsCache {
  constructor() {
    this._localCache = new Map();
    this._kRitmExports = Symbol("RitmExports");
  }

  has(filename, isBuiltin) {
    if (this._localCache.has(filename)) {
      return true;
    } else if (!isBuiltin) {
      const mod = require.cache[filename];
      return !!(mod && this._kRitmExports in mod);
    } else {
      return false;
    }
  }

  get(filename, isBuiltin) {
    const cachedExports = this._localCache.get(filename);
    if (cachedExports !== undefined) {
      return cachedExports;
    } else if (!isBuiltin) {
      const mod = require.cache[filename];
      return mod && mod[this._kRitmExports];
    }
  }

  set(filename, exports, isBuiltin) {
    if (isBuiltin) {
      this._localCache.set(filename, exports);
    } else if (filename in require.cache) {
      require.cache[filename][this._kRitmExports] = exports;
    } else {
      this._localCache.set(filename, exports);
    }
  }
}

function normalizeModules(modules) {
  if (!Array.isArray(modules) || modules.length === 0) {
    throw new TypeError(
      "Braintrust require-in-the-middle requires a non-empty modules array",
    );
  }

  for (const each of modules) {
    if (typeof each !== "string") {
      throw new TypeError(
        "Braintrust require-in-the-middle only supports string module names or absolute paths",
      );
    }
  }

  return modules;
}

function Hook(modules, onrequire) {
  if (this instanceof Hook === false) return new Hook(modules, onrequire);

  modules = normalizeModules(modules);
  if (typeof onrequire !== "function") {
    throw new TypeError(
      "Braintrust require-in-the-middle requires an onrequire function",
    );
  }

  if (typeof Module._resolveFilename !== "function") {
    throw new Error(
      `Expected Module._resolveFilename to be a function, got ${typeof Module._resolveFilename}`,
    );
  }

  this._cache = new ExportsCache();
  this._unhooked = false;
  this._origRequire = Module.prototype.require;

  const self = this;
  const patching = new Set();

  this._require = Module.prototype.require = function (id) {
    if (self._unhooked === true) {
      return self._origRequire.apply(this, arguments);
    }

    return patchedRequire.call(this, arguments, false);
  };

  if (typeof process.getBuiltinModule === "function") {
    this._origGetBuiltinModule = process.getBuiltinModule;
    this._getBuiltinModule = process.getBuiltinModule = function (id) {
      if (self._unhooked === true) {
        return self._origGetBuiltinModule.apply(this, arguments);
      }

      return patchedRequire.call(this, arguments, true);
    };
  }

  function patchedRequire(args, coreOnly) {
    const id = args[0];
    const core = isCore(id);
    let filename;
    if (core) {
      filename = id;
      if (id.startsWith("node:")) {
        const idWithoutPrefix = id.slice(5);
        if (isCore(idWithoutPrefix)) {
          filename = idWithoutPrefix;
        }
      }
    } else if (coreOnly) {
      return self._origGetBuiltinModule.apply(this, args);
    } else {
      try {
        filename = Module._resolveFilename(id, this);
      } catch (resolveErr) {
        return self._origRequire.apply(this, args);
      }
    }

    if (self._cache.has(filename, core) === true) {
      return self._cache.get(filename, core);
    }

    const isPatching = patching.has(filename);
    if (isPatching === false) {
      patching.add(filename);
    }

    const exports = coreOnly
      ? self._origGetBuiltinModule.apply(this, args)
      : self._origRequire.apply(this, args);

    if (isPatching === true) {
      return exports;
    }

    patching.delete(filename);

    let moduleName;
    let basedir;

    if (core === true) {
      if (modules.includes(filename) === false) {
        return exports;
      }
      moduleName = filename;
    } else if (modules.includes(filename)) {
      const parsedPath = path.parse(filename);
      moduleName = parsedPath.name;
      basedir = parsedPath.dir;
    } else {
      const stat = moduleDetailsFromPath(filename);
      if (stat === undefined) {
        return exports;
      }
      moduleName = stat.name;
      basedir = stat.basedir;

      const fullModuleName = resolveModuleName(stat);
      let matchFound = false;
      if (!id.startsWith(".") && modules.includes(id)) {
        moduleName = id;
        matchFound = true;
      }

      if (!modules.includes(moduleName) && !modules.includes(fullModuleName)) {
        return exports;
      }

      if (modules.includes(fullModuleName) && fullModuleName !== moduleName) {
        moduleName = fullModuleName;
        matchFound = true;
      }

      if (!matchFound) {
        let res;
        try {
          res = require.resolve(moduleName, { paths: [basedir] });
        } catch (e) {
          self._cache.set(filename, exports, core);
          return exports;
        }

        if (res !== filename) {
          self._cache.set(filename, exports, core);
          return exports;
        }
      }
    }

    self._cache.set(filename, exports, core);
    const patchedExports = onrequire(exports, moduleName, basedir);
    self._cache.set(filename, patchedExports, core);

    return patchedExports;
  }
}

Hook.prototype.unhook = function () {
  this._unhooked = true;

  if (this._require === Module.prototype.require) {
    Module.prototype.require = this._origRequire;
  }

  if (process.getBuiltinModule !== undefined) {
    if (this._getBuiltinModule === process.getBuiltinModule) {
      process.getBuiltinModule = this._origGetBuiltinModule;
    }
  }
};

function resolveModuleName(stat) {
  const normalizedPath =
    path.sep !== "/" ? stat.path.split(path.sep).join("/") : stat.path;
  return path.posix.join(stat.name, normalizedPath).replace(normalize, "");
}
