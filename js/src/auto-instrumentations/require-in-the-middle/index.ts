import Module from "node:module";
import moduleDetailsFromPath from "module-details-from-path";
import path from "node:path";

export type OnRequireFn<Exports = unknown, PatchedExports = Exports> = (
  exports: Exports,
  name: string,
  basedir?: string,
) => PatchedExports;

export interface Hook<Exports = unknown, PatchedExports = Exports> {
  unhook(): void;
}

export interface HookConstructor {
  new <Exports = unknown, PatchedExports = Exports>(
    modules: readonly string[],
    onrequire: OnRequireFn<Exports, PatchedExports>,
  ): Hook<Exports, PatchedExports>;
  <Exports = unknown, PatchedExports = Exports>(
    modules: readonly string[],
    onrequire: OnRequireFn<Exports, PatchedExports>,
  ): Hook<Exports, PatchedExports>;
}

type GetBuiltinModuleFn = (this: unknown, id: string) => unknown;
type ProcessWithGetBuiltinModule = Omit<typeof process, "getBuiltinModule"> & {
  getBuiltinModule?: GetBuiltinModuleFn;
};
type ModuleWithInternals = typeof Module & {
  _resolveFilename(id: string, parent: NodeJS.Module): string;
};
type CachedModule = NodeJS.Module & Record<symbol, unknown>;
type HookedRequire = (this: NodeJS.Module, id: string) => unknown;

interface HookInstance {
  _cache: ExportsCache;
  _getBuiltinModule?: GetBuiltinModuleFn;
  _origGetBuiltinModule?: GetBuiltinModuleFn;
  _origRequire: HookedRequire;
  _require: HookedRequire;
  _unhooked: boolean;
}

interface HookImplementationConstructor {
  new (modules: unknown, onrequire: unknown): HookInstance;
  (modules: unknown, onrequire: unknown): HookInstance;
  prototype: HookInstance & { unhook(): void };
}

let builtinModules: Set<string> | undefined;

const ModuleInternals = Module as ModuleWithInternals;
let isCore: (moduleName: string) => boolean;
if (Module.isBuiltin) {
  isCore = Module.isBuiltin;
} else if (Module.builtinModules) {
  isCore = (moduleName: string) => {
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
  private readonly localCache = new Map<string, unknown>();
  private readonly kRitmExports = Symbol("RitmExports");

  has(filename: string, isBuiltin: boolean): boolean {
    if (this.localCache.has(filename)) {
      return true;
    } else if (!isBuiltin) {
      const mod = require.cache[filename] as CachedModule | undefined;
      return !!(mod && this.kRitmExports in mod);
    } else {
      return false;
    }
  }

  get(filename: string, isBuiltin: boolean): unknown {
    const cachedExports = this.localCache.get(filename);
    if (cachedExports !== undefined) {
      return cachedExports;
    } else if (!isBuiltin) {
      const mod = require.cache[filename] as CachedModule | undefined;
      return mod && mod[this.kRitmExports];
    }
  }

  set(filename: string, exports: unknown, isBuiltin: boolean): void {
    if (isBuiltin) {
      this.localCache.set(filename, exports);
    } else if (filename in require.cache) {
      (require.cache[filename] as CachedModule)[this.kRitmExports] = exports;
    } else {
      this.localCache.set(filename, exports);
    }
  }
}

function normalizeModules(modules: unknown): string[] {
  if (!Array.isArray(modules) || modules.length === 0) {
    throw new TypeError(
      "Braintrust require-in-the-middle requires a non-empty modules array",
    );
  }

  const normalized: string[] = [];
  for (const each of modules) {
    if (typeof each !== "string") {
      throw new TypeError(
        "Braintrust require-in-the-middle only supports string module names or absolute paths",
      );
    }
    normalized.push(each);
  }

  return normalized;
}

const Hook: HookImplementationConstructor = function (
  this: HookInstance | undefined,
  modules: unknown,
  onrequire: unknown,
): HookInstance | void {
  if (!this || !(this instanceof Hook)) {
    return new Hook(modules, onrequire);
  }

  const normalizedModules = normalizeModules(modules);
  if (typeof onrequire !== "function") {
    throw new TypeError(
      "Braintrust require-in-the-middle requires an onrequire function",
    );
  }
  const onRequireFn = onrequire as OnRequireFn;

  if (typeof ModuleInternals._resolveFilename !== "function") {
    throw new Error(
      `Expected Module._resolveFilename to be a function, got ${typeof ModuleInternals._resolveFilename}`,
    );
  }

  this._cache = new ExportsCache();
  this._unhooked = false;
  this._origRequire = Module.prototype.require;

  const self = this;
  const patching = new Set<string>();

  this._require = Module.prototype.require = function (
    this: NodeJS.Module,
    id: string,
  ) {
    if (self._unhooked === true) {
      return self._origRequire.call(this, id);
    }

    return patchedRequire.call(this, id, false);
  };

  const processWithGetBuiltinModule: ProcessWithGetBuiltinModule = process;
  if (typeof processWithGetBuiltinModule.getBuiltinModule === "function") {
    this._origGetBuiltinModule = processWithGetBuiltinModule.getBuiltinModule;
    this._getBuiltinModule = processWithGetBuiltinModule.getBuiltinModule =
      function (this: unknown, id: string) {
        if (self._unhooked === true) {
          return getOrigGetBuiltinModule().call(this, id);
        }

        return patchedRequire.call(this as NodeJS.Module, id, true);
      };
  }

  function getOrigGetBuiltinModule(): GetBuiltinModuleFn {
    if (!self._origGetBuiltinModule) {
      throw new Error(
        "Expected process.getBuiltinModule to be captured before patching builtins",
      );
    }
    return self._origGetBuiltinModule;
  }

  function patchedRequire(
    this: NodeJS.Module,
    id: string,
    coreOnly: boolean,
  ): unknown {
    const core = isCore(id);
    let filename: string;
    if (core) {
      filename = id;
      if (id.startsWith("node:")) {
        const idWithoutPrefix = id.slice(5);
        if (isCore(idWithoutPrefix)) {
          filename = idWithoutPrefix;
        }
      }
    } else if (coreOnly) {
      return getOrigGetBuiltinModule().call(this, id);
    } else {
      try {
        filename = ModuleInternals._resolveFilename(id, this);
      } catch {
        return self._origRequire.call(this, id);
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
      ? getOrigGetBuiltinModule().call(this, id)
      : self._origRequire.call(this, id);

    if (isPatching === true) {
      return exports;
    }

    patching.delete(filename);

    let moduleName: string;
    let basedir: string | undefined;

    if (core === true) {
      if (normalizedModules.includes(filename) === false) {
        return exports;
      }
      moduleName = filename;
    } else if (normalizedModules.includes(filename)) {
      const parsedPath = path.parse(filename);
      moduleName = parsedPath.name;
      basedir = parsedPath.dir;
    } else {
      const stat = moduleDetailsFromPath(filename);
      if (stat === undefined || stat === null) {
        return exports;
      }
      moduleName = stat.name;
      basedir = stat.basedir;

      const fullModuleName = resolveModuleName(stat);
      let matchFound = false;
      if (!id.startsWith(".") && normalizedModules.includes(id)) {
        moduleName = id;
        matchFound = true;
      }

      if (
        !normalizedModules.includes(moduleName) &&
        !normalizedModules.includes(fullModuleName)
      ) {
        return exports;
      }

      if (
        normalizedModules.includes(fullModuleName) &&
        fullModuleName !== moduleName
      ) {
        moduleName = fullModuleName;
        matchFound = true;
      }

      if (!matchFound) {
        let res: string;
        try {
          res = require.resolve(moduleName, { paths: [basedir as string] });
        } catch {
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
    const patchedExports = onRequireFn(exports, moduleName, basedir);
    self._cache.set(filename, patchedExports, core);

    return patchedExports;
  }
} as HookImplementationConstructor;

Hook.prototype.unhook = function (this: HookInstance): void {
  this._unhooked = true;

  if (this._require === Module.prototype.require) {
    Module.prototype.require = this._origRequire;
  }

  const processWithGetBuiltinModule: ProcessWithGetBuiltinModule = process;
  if (processWithGetBuiltinModule.getBuiltinModule !== undefined) {
    if (
      this._getBuiltinModule === processWithGetBuiltinModule.getBuiltinModule
    ) {
      if (this._origGetBuiltinModule) {
        processWithGetBuiltinModule.getBuiltinModule =
          this._origGetBuiltinModule;
      }
    }
  }
};

module.exports = Hook;
module.exports.Hook = Hook;

function resolveModuleName(stat: { name: string; path: string }): string {
  const normalizedPath =
    path.sep !== "/" ? stat.path.split(path.sep).join("/") : stat.path;
  return path.posix.join(stat.name, normalizedPath).replace(normalize, "");
}

export {};
