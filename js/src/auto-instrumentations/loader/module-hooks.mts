/**
 * Module load hooks for auto-instrumentation.
 * `load` runs in the module.register() loader thread and transforms imported
 * ES and CommonJS modules.
 * `loadSync` runs in-thread via module.registerHooks() and transforms both
 * ES modules and CommonJS require() calls.
 */

import { debugLogger } from "../../debug-logger.js";

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extname, sep } from "node:path";
import {
  InstrumentationMatcher,
  type InstrumentationConfig,
} from "../orchestrion-js";
import moduleDetailsFromPath from "module-details-from-path";
import { getPackageInfo } from "./get-package-info.js";
import {
  applySpecialCasePatch,
  isSpecialCaseTarget,
} from "./special-case-patches.js";

let matcher: InstrumentationMatcher;

/**
 * CommonJS sources produced by `loadSync`, keyed by filename. The
 * Module._compile patch skips a file only when it receives exactly this source;
 * loaders such as tsx may discard it and compile the original file instead.
 */
export const syncTransformedSources = new Map<string, string>();

function getModuleType(url: string, format: string | undefined) {
  if (format === "module") {
    return "esm";
  }
  if (format === "commonjs") {
    return "cjs";
  }

  const pathname = url.startsWith("file:") ? fileURLToPath(url) : url;
  const ext = extname(pathname);
  if (ext === ".mjs") {
    return "esm";
  }
  if (ext === ".cjs") {
    return "cjs";
  }

  return "unknown";
}

export function initialize({
  instrumentations,
}: {
  instrumentations: InstrumentationConfig[];
}) {
  matcher = new InstrumentationMatcher(instrumentations);
}

export async function load(url: string, context: any, nextLoad: Function) {
  const result = await nextLoad(url, context);
  const instrumentation = getModuleInstrumentation(url);
  if (!instrumentation) return result;

  // Node may omit CommonJS source; only read it for an instrumentation target.
  if (result.format === "commonjs") {
    result.source ??= await readFile(new URL(result.responseURL ?? url));
  }
  return transformLoadedModule(url, result, instrumentation);
}

export function loadSync(url: string, context: any, nextLoad: Function) {
  const result = nextLoad(url, context);
  const instrumentation = getModuleInstrumentation(url);
  if (!instrumentation) return result;

  // Sync hooks receive nullish CommonJS source when an async loader from
  // module.register() is also active.
  if (result.format === "commonjs") {
    result.source ??= readFileSync(new URL(result.responseURL ?? url));
  }
  transformLoadedModule(url, result, instrumentation);
  // CommonJS files without a package type field have no format yet.
  if (result.format !== "module" && result.shortCircuit) {
    syncTransformedSources.set(instrumentation.filePath, result.source);
  }
  return result;
}

function getModuleInstrumentation(url: string) {
  // import-in-the-middle proxies a module through a generated wrapper at the
  // same path with an `iitm` search param. Only the real module is a target.
  if (url.includes("iitm") && new URL(url).searchParams.has("iitm")) return;

  const filePath = url.startsWith("file:") ? fileURLToPath(url) : url;
  const resolvedModule = moduleDetailsFromPath(filePath.split("/").join(sep));
  if (!resolvedModule) return;

  const packageInfo = getPackageInfo(resolvedModule.basedir);
  const packageName = packageInfo?.name ?? resolvedModule.name;
  const modulePath = resolvedModule.path.replace(/\\/g, "/");
  const specialCase = isSpecialCaseTarget(packageName, modulePath);
  const transformer =
    !specialCase && packageInfo?.version
      ? matcher.getTransformer(packageName, packageInfo.version, modulePath)
      : undefined;
  if (!specialCase && !transformer) return;

  return { filePath, packageName, modulePath, specialCase, transformer };
}

function transformLoadedModule(
  url: string,
  result: any,
  {
    packageName,
    modulePath,
    specialCase,
    transformer,
  }: NonNullable<ReturnType<typeof getModuleInstrumentation>>,
) {
  if (!result.source) return result;
  // Async loaders transfer bytes across a worker boundary, losing Buffer's
  // toString implementation. Decode any byte source explicitly.
  const source =
    typeof result.source === "string"
      ? result.source
      : new TextDecoder().decode(result.source);

  if (specialCase) {
    const patched = applySpecialCasePatch({
      packageName,
      modulePath,
      source,
      format: result.format === "commonjs" ? "cjs" : "esm",
    });
    if (patched !== null) {
      result.source = patched;
      result.shortCircuit = true;
    }
  } else if (transformer) {
    try {
      result.source = transformer.transform(
        source,
        getModuleType(url, result.format),
      ).code;
      result.shortCircuit = true;
    } catch (err) {
      debugLogger.notice.warn(`Error transforming module ${url}:`, err);
    }
  }
  return result;
}
