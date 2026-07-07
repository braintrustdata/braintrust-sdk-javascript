import { lexEsm } from "./get-esm-exports.mjs";
import { parse as parseCjs, initSync } from "cjs-module-lexer";
import { existsSync, readFileSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LOAD } from "./io.mjs";
import type {
  LoaderContext,
  LoaderOperation,
  LoadOperation,
  LoadResult,
} from "./io.mjs";

const nodeMajor = Number(process.versions.node.split(".")[0]);
export const hasModuleExportsCJSDefault = nodeMajor >= 23;

type StripTypeScriptTypes = (
  source: string,
  options: { mode: "strip" },
) => string;

const stripTypeScriptTypes = (
  process as NodeJS.Process & {
    getBuiltinModule?: (name: "module") => {
      stripTypeScriptTypes?: StripTypeScriptTypes;
    };
  }
).getBuiltinModule?.("module").stripTypeScriptTypes;

let parserInitialized = false;

// The CJS export scanner is backed by WebAssembly. `initSync` compiles it
// up front so the scanner can run inside synchronous loader hooks
// (`module.registerHooks`) as well as the off-thread loader; it is a one-time
// cost on the first CommonJS module either way.
function ensureParserInitialized() {
  if (!parserInitialized) {
    initSync();
    parserInitialized = true;
  }
}

type NodeRequire = ReturnType<typeof createRequire>;
type ExportGenerator = Generator<LoaderOperation, Set<string>, LoadResult>;
type PackageImportBranch = {
  default?: unknown;
  node?: unknown;
};
type PackageImportObject = PackageImportBranch & {
  import?: unknown;
  require?: unknown;
};

function addDefault(arr: Iterable<string>): Set<string> {
  return new Set(["default", ...arr]);
}

// Cached exports for Node built-in modules
const BUILT_INS = new Map<string, Set<string>>();
const esmExportsCache = new Map<string, { exportNames: Set<string> }>();

let require: NodeRequire | undefined;

function getRequire(): NodeRequire {
  if (!require) {
    require = createRequire(pathToFileURL(process.execPath));
  }
  return require;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function getStringProperty(
  value: Record<string, unknown>,
  property: string,
): string | undefined {
  const result = value[property];
  return typeof result === "string" ? result : undefined;
}

function getImportBranch(value: unknown): PackageImportBranch | undefined {
  return isRecord(value) ? value : undefined;
}

function getPackageImportTarget(imports: unknown): string | undefined {
  if (typeof imports === "string") {
    return imports;
  }

  if (!isRecord(imports)) {
    return undefined;
  }

  const conditionalImports = imports as PackageImportObject;
  const requireExport = getImportBranch(conditionalImports.require);
  const importExport = getImportBranch(conditionalImports.import);

  if (requireExport || importExport) {
    return (
      (requireExport && getStringProperty(requireExport, "node")) ||
      (requireExport && getStringProperty(requireExport, "default")) ||
      (importExport && getStringProperty(importExport, "node")) ||
      (importExport && getStringProperty(importExport, "default"))
    );
  }

  return (
    getStringProperty(conditionalImports, "node") ||
    getStringProperty(conditionalImports, "default")
  );
}

// Returns a builtin's exports object. `process.getBuiltinModule` (Node >=
// 20.16 / >= 22.3) bypasses registered loader hooks; `require` does not. Under
// the in-thread `module.registerHooks` loader a plain `require(name)` here
// re-enters iitm's own hooks and resolves to the half-built wrapper instead of
// the native module. The off-thread `module.register` loader runs `require` on
// the loader thread where the hooks aren't installed, so the fallback stays
// correct on older Node that lacks getBuiltinModule.
function loadBuiltin(name: string): unknown {
  if (typeof process.getBuiltinModule === "function") {
    return process.getBuiltinModule(name);
  }
  return getRequire()(name);
}

function getExportsForNodeBuiltIn(name: string): Set<string> {
  let exports = BUILT_INS.get(name);

  if (!exports) {
    // get all properties both enumerable and non-enumerable
    exports = new Set(
      addDefault(Object.getOwnPropertyNames(loadBuiltin(name) as object)),
    );
    // added in node 23 as alias for default in cjs modules
    if (hasModuleExportsCJSDefault) {
      exports.add("module.exports");
    }
    BUILT_INS.set(name, exports);
  }

  return exports;
}

const urlsBeingProcessed = new Set(); // Guard against circular imports.

/**
 * This function looks for the package.json which contains the specifier trying to resolve.
 * Once the package.json file has been found, we extract the file path from the specifier
 * @param {string} specifier The specifier that is being search for inside the imports object
 * @param {URL|string} fromUrl The url from which the search starts from
 * @returns array with url and resolvedExport
 */
function resolvePackageImports(
  specifier: string,
  fromUrl: URL | string,
): [URL | string, string] | null {
  try {
    const fromPath = fileURLToPath(fromUrl);
    let currentDir = dirname(fromPath);

    // search for package.json file which has the real url to export
    while (currentDir !== dirname(currentDir)) {
      const packageJsonPath = join(currentDir, "package.json");

      if (existsSync(packageJsonPath)) {
        const packageJson = JSON.parse(
          readFileSync(packageJsonPath, "utf8"),
        ) as unknown;
        const packageImports =
          isRecord(packageJson) && isRecord(packageJson.imports)
            ? packageJson.imports[specifier]
            : undefined;

        if (packageImports) {
          const resolvedExport = getPackageImportTarget(packageImports);

          if (resolvedExport) {
            const url = resolvedExport.startsWith(".")
              ? pathToFileURL(join(currentDir, resolvedExport))
              : fromUrl;
            return [url, resolvedExport];
          }
        }
        // return if we find a package.json but did not find an import
        return null;
      }

      currentDir = dirname(currentDir);
    }
  } catch (cause) {
    throw Error(`Failed to find export: ${specifier}`, { cause });
  }
  return null;
}

function* getCjsExports(
  url: string,
  context: LoaderContext,
  source: string,
): ExportGenerator {
  if (urlsBeingProcessed.has(url)) {
    return new Set();
  }
  urlsBeingProcessed.add(url);

  try {
    ensureParserInitialized();
    const result = parseCjs(source);
    const full = addDefault(result.exports);

    for (const reexport of result.reexports) {
      if (reexport.startsWith("node:") || builtinModules.includes(reexport)) {
        for (const each of getExportsForNodeBuiltIn(reexport)) {
          full.add(each);
        }
        continue;
      }

      // Resolve each re-export relative to the current module. Keep the
      // resolution scoped to this iteration: a `#`-import rewrites both the
      // base URL and the specifier, and that rewrite must not leak into the
      // next re-export.
      let reUrl: string | URL = url;
      let reSpecifier = reexport === "." ? "./" : reexport;

      // Entries in the import field should always start with #
      if (reSpecifier.startsWith("#")) {
        const resolved = resolvePackageImports(reSpecifier, url);
        if (!resolved) continue;
        [reUrl, reSpecifier] = resolved;
      }

      const newUrl = pathToFileURL(
        getRequire().resolve(reSpecifier, {
          paths: [dirname(fileURLToPath(reUrl))],
        }),
      ).href;

      if (newUrl.endsWith(".node") || newUrl.endsWith(".json")) {
        continue;
      }

      for (const each of yield* getExports(newUrl, context)) {
        full.add(each);
      }
    }

    // added in node 23 as alias for default in cjs modules
    if (full.has("default") && hasModuleExportsCJSDefault) {
      full.add("module.exports");
    }

    // we know that it's commonjs at this point, because ESM failed
    context.format = "commonjs";
    return full;
  } finally {
    urlsBeingProcessed.delete(url);
  }
}

/**
 * Inspects a module for its type (commonjs or module), obtains the source code
 * for said module from the loader API, and parses the result for the entities
 * exported from that module.
 *
 * This is a "sans-io" generator: instead of calling the loader's `load` hook
 * directly, it `yield`s `[LOAD, url, context]` and is driven by either
 * {@link driveSync} or {@link driveAsync} (see `lib/io.mjs`). The same body
 * therefore serves both the off-thread loader and `module.registerHooks`.
 *
 * @param {string} url A file URL string pointing to the module that we should
 * get the exports of.
 * @param {object} context Context object as provided by the `load` hook from
 * the loaders API.
 *
 * @returns {Generator<Array, Set<string>>} A generator that yields I/O
 * operations and ultimately returns the identifiers exported by the module.
 * Please see {@link getEsmExports} for caveats on special identifiers that may
 * be included in the result set.
 */
export function* getExports(
  url: string,
  context: LoaderContext,
): ExportGenerator {
  const cached = esmExportsCache.get(url);
  if (cached !== undefined) {
    return cached.exportNames;
  }

  // `[LOAD, ...]` gives us the possibility of getting the source from an
  // upstream loader. This doesn't always work though, so later on we fall back
  // to reading it from disk.
  const loadOperation: LoadOperation = [LOAD, url, context];
  const parentCtx = yield loadOperation;
  let source = parentCtx.source;
  const format = parentCtx.format;

  // Loader hooks can return ArrayBuffer / TypedArray sources. Normalize to a
  // string for parsing.
  if (source && typeof source !== "string") {
    // Avoid copies where possible:
    // - Buffer.from(Uint8Array) copies
    // - Buffer.from(ArrayBuffer, offset, length) wraps the existing memory
    if (Buffer.isBuffer(source)) {
      source = source.toString("utf8");
    } else if (ArrayBuffer.isView(source)) {
      source = Buffer.from(
        source.buffer,
        source.byteOffset,
        source.byteLength,
      ).toString("utf8");
    } else {
      source = Buffer.from(source).toString("utf8");
    }
  }

  if (!source) {
    if (format === "builtin") {
      // Builtins don't give us the source property, so we're stuck
      // just requiring it to get the exports.
      return getExportsForNodeBuiltIn(url);
    }

    // Sometimes source is retrieved by parentLoad, CommonJs isn't.
    source = readFileSync(fileURLToPath(url), "utf8");
  }

  try {
    let moduleSource = source as string;
    let moduleFormat = format;
    if (
      moduleFormat === "module-typescript" ||
      moduleFormat === "commonjs-typescript"
    ) {
      if (stripTypeScriptTypes !== undefined) {
        moduleSource = stripTypeScriptTypes(moduleSource, { mode: "strip" });
      }
      moduleFormat =
        moduleFormat === "module-typescript" ? "module" : "commonjs";
    }

    if (moduleFormat === "commonjs") {
      return yield* getCjsExports(url, context, moduleSource);
    }

    const { exportNames, hasModuleSyntax } = lexEsm(moduleSource);

    if (moduleFormat === "module") {
      esmExportsCache.set(url, { exportNames });
      return exportNames;
    }

    // At this point our `format` is either undefined or not known by us. When
    // there are no exports and no ESM syntax, fall back to CommonJS detection.
    if (!exportNames.size && !hasModuleSyntax) {
      return yield* getCjsExports(url, context, moduleSource);
    }
    esmExportsCache.set(url, { exportNames });
    return exportNames;
  } catch (cause) {
    throw new Error(`Failed to parse '${url}'`, { cause });
  }
}
