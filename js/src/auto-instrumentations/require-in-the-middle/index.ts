import Module from "node:module";
import moduleDetailsFromPath from "module-details-from-path";
import path from "node:path";

type OnRequireFn = (
  exports: unknown,
  name: string,
  basedir?: string,
) => unknown;
type GetBuiltinModuleFn = (this: unknown, id: string) => unknown;
type ProcessWithGetBuiltinModule = Omit<typeof process, "getBuiltinModule"> & {
  getBuiltinModule?: GetBuiltinModuleFn;
};
type ModuleWithInternals = typeof Module & {
  _resolveFilename(id: string, parent: NodeJS.Module): string;
};
type CachedModule = NodeJS.Module & Record<symbol, unknown>;
type HookedRequire = (this: NodeJS.Module, id: string) => unknown;

const ModuleInternals = Module as ModuleWithInternals;
const isCore = Module.isBuiltin;

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

class Hook {
  private readonly _cache = new ExportsCache();
  private readonly _origRequire: HookedRequire;
  private readonly _patching = new Set<string>();
  private readonly _normalizedModules: string[];
  private _getBuiltinModule?: GetBuiltinModuleFn;
  private _origGetBuiltinModule?: GetBuiltinModuleFn;
  private _require: HookedRequire;
  private _unhooked = false;

  constructor(
    modules: readonly string[],
    private readonly _onRequireFn: OnRequireFn,
  ) {
    this._normalizedModules = Array.from(modules);
    this._origRequire = Module.prototype.require;
    const self = this;

    this._require = Module.prototype.require = function (
      this: NodeJS.Module,
      id: string,
    ) {
      if (self._unhooked === true) {
        return self._origRequire.call(this, id);
      }

      return self._patchedRequire(this, id, false);
    };

    const processWithGetBuiltinModule: ProcessWithGetBuiltinModule = process;
    if (typeof processWithGetBuiltinModule.getBuiltinModule === "function") {
      this._origGetBuiltinModule = processWithGetBuiltinModule.getBuiltinModule;
      this._getBuiltinModule = processWithGetBuiltinModule.getBuiltinModule =
        function (this: unknown, id: string) {
          if (self._unhooked === true) {
            return self._origGetBuiltinModule!.call(this, id);
          }

          return self._patchedRequire(this as NodeJS.Module, id, true);
        };
    }
  }

  unhook(): void {
    this._unhooked = true;

    if (this._require === Module.prototype.require) {
      Module.prototype.require = this._origRequire;
    }

    const processWithGetBuiltinModule: ProcessWithGetBuiltinModule = process;
    if (
      this._getBuiltinModule &&
      this._getBuiltinModule === processWithGetBuiltinModule.getBuiltinModule
    ) {
      processWithGetBuiltinModule.getBuiltinModule = this._origGetBuiltinModule;
    }
  }

  private _patchedRequire(
    requireThis: NodeJS.Module,
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
      return this._origGetBuiltinModule!.call(requireThis, id);
    } else {
      try {
        filename = ModuleInternals._resolveFilename(id, requireThis);
      } catch {
        return this._origRequire.call(requireThis, id);
      }
    }

    if (this._cache.has(filename, core) === true) {
      return this._cache.get(filename, core);
    }

    const isPatching = this._patching.has(filename);
    if (isPatching === false) {
      this._patching.add(filename);
    }

    const exports = coreOnly
      ? this._origGetBuiltinModule!.call(requireThis, id)
      : this._origRequire.call(requireThis, id);

    if (isPatching === true) {
      return exports;
    }

    this._patching.delete(filename);

    let moduleName: string;
    let basedir: string | undefined;

    if (core === true) {
      if (this._normalizedModules.includes(filename) === false) {
        return exports;
      }
      moduleName = filename;
    } else if (this._normalizedModules.includes(filename)) {
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
      if (!id.startsWith(".") && this._normalizedModules.includes(id)) {
        moduleName = id;
        matchFound = true;
      }

      if (
        !this._normalizedModules.includes(moduleName) &&
        !this._normalizedModules.includes(fullModuleName)
      ) {
        return exports;
      }

      if (
        this._normalizedModules.includes(fullModuleName) &&
        fullModuleName !== moduleName
      ) {
        moduleName = fullModuleName;
        matchFound = true;
      }

      if (!matchFound) {
        let res: string;
        try {
          res = require.resolve(moduleName, { paths: [basedir] });
        } catch {
          this._cache.set(filename, exports, core);
          return exports;
        }

        if (res !== filename) {
          this._cache.set(filename, exports, core);
          return exports;
        }
      }
    }

    this._cache.set(filename, exports, core);
    const patchedExports = this._onRequireFn(exports, moduleName, basedir);
    this._cache.set(filename, patchedExports, core);

    return patchedExports;
  }
}

module.exports = Hook;
module.exports.Hook = Hook;

function resolveModuleName(stat: { name: string; path: string }): string {
  const normalizedPath =
    path.sep !== "/" ? stat.path.split(path.sep).join("/") : stat.path;
  return path.posix.join(stat.name, normalizedPath).replace(normalize, "");
}

export {};
