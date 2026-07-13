import moduleDetailsFromPath from "module-details-from-path";
import Module, { builtinModules, createRequire } from "node:module";
import { parse as parsePath } from "node:path";
import { pathToFileURL } from "node:url";

type OnRequireFn = <T>(exports: T, name: string, basedir?: string) => T;
type GetBuiltinModuleFn = (this: unknown, id: string) => unknown;
type HookedRequire = (this: NodeJS.Module, id: string) => unknown;
type ModuleWithInternals = typeof Module & {
  _cache: Record<string, (NodeJS.Module & Record<symbol, unknown>) | undefined>;
  _resolveFilename(id: string, parent: NodeJS.Module): string;
};

let builtinModulesSet: Set<string> | undefined;
const ModuleInternals = Module as ModuleWithInternals;
const requireForResolve = createRequire(
  pathToFileURL(process.argv[1] ?? process.cwd()).href,
);

const isCore =
  typeof Module.isBuiltin === "function"
    ? Module.isBuiltin
    : (moduleName: string) => {
        if (moduleName.startsWith("node:")) {
          return true;
        }

        builtinModulesSet ??= new Set(builtinModules);
        return builtinModulesSet.has(moduleName);
      };

const normalize = /([/\\]index)?(\.js|\.cjs)?$/;

class ExportsCache {
  private readonly localCache = new Map<string, unknown>();
  private readonly kRitmExports = Symbol("RitmExports");

  has(filename: string, isBuiltin: boolean): boolean {
    if (this.localCache.has(filename)) {
      return true;
    } else if (!isBuiltin) {
      const mod = ModuleInternals._cache[filename] as
        | (NodeJS.Module & Record<symbol, unknown>)
        | undefined;
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
      const mod = ModuleInternals._cache[filename] as
        | (NodeJS.Module & Record<symbol, unknown>)
        | undefined;
      return mod && mod[this.kRitmExports];
    }
  }

  set(filename: string, exports: unknown, isBuiltin: boolean): void {
    if (isBuiltin) {
      this.localCache.set(filename, exports);
    } else if (filename in ModuleInternals._cache) {
      (
        ModuleInternals._cache[filename] as NodeJS.Module &
          Record<symbol, unknown>
      )[this.kRitmExports] = exports;
    } else {
      this.localCache.set(filename, exports);
    }
  }
}

function normalizeModules(modules: string[]): string[] {
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

export default class Hook {
  private readonly cache = new ExportsCache();
  private readonly hookedRequire: HookedRequire;
  private hookedGetBuiltinModule?: GetBuiltinModuleFn;
  private unhooked = false;
  private readonly origRequire = Module.prototype.require;
  private readonly origGetBuiltinModule: GetBuiltinModuleFn | undefined = (
    process as unknown as { getBuiltinModule?: GetBuiltinModuleFn }
  ).getBuiltinModule;

  constructor(modules: string[], onrequire: OnRequireFn) {
    modules = normalizeModules(modules);
    if (typeof onrequire !== "function") {
      throw new TypeError(
        "Braintrust require-in-the-middle requires an onrequire function",
      );
    }

    if (typeof ModuleInternals._resolveFilename !== "function") {
      throw new Error(
        `Expected Module._resolveFilename to be a function, got ${typeof ModuleInternals._resolveFilename}`,
      );
    }

    const self = this;
    const patching = new Set<string>();

    this.hookedRequire = Module.prototype.require = function (id: string) {
      if (self.unhooked === true) {
        return self.origRequire.apply(this, arguments as any);
      }

      return patchedRequire.call(this, arguments, false);
    };

    if (typeof this.origGetBuiltinModule === "function") {
      this.hookedGetBuiltinModule = (
        process as unknown as { getBuiltinModule: GetBuiltinModuleFn }
      ).getBuiltinModule = function (id: string) {
        if (self.unhooked === true) {
          return self.origGetBuiltinModule!.apply(process, arguments as any);
        }

        return patchedRequire.call(
          process as unknown as NodeJS.Module,
          arguments,
          true,
        );
      };
    }

    function patchedRequire(
      this: NodeJS.Module,
      args: IArguments,
      coreOnly: boolean,
    ): unknown {
      const id = args[0] as string;
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
        return self.origGetBuiltinModule!.call(process, id);
      } else {
        try {
          filename = ModuleInternals._resolveFilename(id, this);
        } catch {
          return self.origRequire.apply(this, args as any);
        }
      }

      if (self.cache.has(filename, core) === true) {
        return self.cache.get(filename, core);
      }

      const isPatching = patching.has(filename);
      if (isPatching === false) {
        patching.add(filename);
      }

      const exports = coreOnly
        ? self.origGetBuiltinModule!.call(process, id)
        : self.origRequire.apply(this, args as any);

      if (isPatching === true) {
        return exports;
      }

      patching.delete(filename);

      let moduleName: string;
      let basedir: string | undefined;

      if (core === true) {
        if (modules.includes(filename) === false) {
          return exports;
        }
        moduleName = filename;
      } else if (modules.includes(filename)) {
        const parsedPath = parsePath(filename);
        moduleName = parsedPath.name;
        basedir = parsedPath.dir;
      } else {
        const stat = moduleDetailsFromPath(filename);
        if (!stat) {
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

        if (
          !modules.includes(moduleName) &&
          !modules.includes(fullModuleName)
        ) {
          return exports;
        }

        if (modules.includes(fullModuleName) && fullModuleName !== moduleName) {
          moduleName = fullModuleName;
          matchFound = true;
        }

        if (!matchFound) {
          let res: string;
          try {
            res = requireForResolve.resolve(moduleName, {
              paths: basedir ? [basedir] : undefined,
            });
          } catch {
            self.cache.set(filename, exports, core);
            return exports;
          }

          if (res !== filename) {
            self.cache.set(filename, exports, core);
            return exports;
          }
        }
      }

      const patchedExports = onrequire(exports, moduleName, basedir);
      self.cache.set(filename, patchedExports, core);
      return patchedExports;
    }
  }

  unhook(): void {
    this.unhooked = true;
    if (Module.prototype.require === this.hookedRequire) {
      Module.prototype.require = this.origRequire;
    }
    const processWithGetBuiltinModule = process as unknown as {
      getBuiltinModule?: GetBuiltinModuleFn;
    };
    if (
      this.hookedGetBuiltinModule &&
      processWithGetBuiltinModule.getBuiltinModule ===
        this.hookedGetBuiltinModule
    ) {
      processWithGetBuiltinModule.getBuiltinModule = this.origGetBuiltinModule;
    }
  }
}

function resolveModuleName(stat: { name: string; path: string }): string {
  return `${stat.name}/${stat.path.replace(normalize, "")}`;
}
