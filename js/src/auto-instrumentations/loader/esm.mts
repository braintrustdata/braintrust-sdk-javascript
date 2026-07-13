/**
 * ESM loader hook for auto-instrumentation.
 * This is used by Node.js --import to transform ES modules at load time.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extname, sep } from "node:path";
import { create, type InstrumentationConfig } from "../orchestrion-js";
import moduleDetailsFromPath from "module-details-from-path";
import { getPackageName, getPackageVersion } from "./package-version.js";
import {
  applySourcePatch,
  isSourcePatchTarget,
} from "./source-patches/index.js";

let instrumentator: any;
let packages: Set<string>;
let transformers: Map<string, any> = new Map();
// URLs that need a per-package source patch (see source-patches/).
// Resolve records the (packageName, modulePath) it already computed so load
// doesn't have to redo the moduleDetailsFromPath roundtrip.
const sourcePatchUrls: Map<
  string,
  { packageName: string; modulePath: string }
> = new Map();

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

export async function initialize(
  data: { instrumentations?: InstrumentationConfig[] } = {},
) {
  // Use the instrumentations passed from the parent via register()
  const configs = data.instrumentations || [];
  instrumentator = create(configs);
  packages = new Set(configs.map((i) => i.module.name));
}

export async function resolve(
  specifier: string,
  context: any,
  nextResolve: Function,
) {
  const url = await nextResolve(specifier, context);

  // Convert file:// URL to path
  const filePath = url.url.startsWith("file:")
    ? fileURLToPath(url.url)
    : url.url;

  // Normalize path to platform-specific separator for module-details-from-path
  // Some bundlers pass forward slashes even on Windows
  const normalizedForPlatform = filePath.split("/").join(sep);

  const resolvedModule = moduleDetailsFromPath(normalizedForPlatform);

  if (resolvedModule) {
    const packageName =
      getPackageName(resolvedModule.basedir) ?? resolvedModule.name;
    const normalizedModulePath = resolvedModule.path.replace(/\\/g, "/");
    const version = getPackageVersion(resolvedModule.basedir);

    // Track files that need per-package source patches (see
    // loader/source-patches/). Anti-pattern fallback for SDKs we
    // can't instrument via the standard pipeline; the load step retrieves
    // the recorded (packageName, modulePath) and applies the patch.
    if (isSourcePatchTarget(packageName, normalizedModulePath)) {
      sourcePatchUrls.set(url.url, {
        packageName,
        modulePath: normalizedModulePath,
      });
    }

    if (!packages?.has(packageName)) {
      return url;
    }

    const transformer = instrumentator.getTransformer(
      packageName,
      version,
      normalizedModulePath,
    );

    if (transformer) {
      transformers.set(url.url, transformer);
    }
  }

  return url;
}

export async function load(url: string, context: any, nextLoad: Function) {
  const result = await nextLoad(url, context);

  // Per-package source patches (see loader/source-patches/).
  // Anti-pattern fallback — keep this branch and the helper module narrow.
  const sourcePatch = sourcePatchUrls.get(url);
  if (sourcePatch) {
    if (result.format === "commonjs") {
      const parsedUrl = new URL(result.responseURL ?? url);
      result.source ??= await readFile(parsedUrl);
    }
    if (result.source) {
      const patched = applySourcePatch({
        packageName: sourcePatch.packageName,
        modulePath: sourcePatch.modulePath,
        source: result.source.toString("utf8"),
        format: result.format === "commonjs" ? "cjs" : "esm",
      });
      if (patched !== null) {
        result.source = patched;
        result.shortCircuit = true;
      }
    }
    return result;
  }

  if (!transformers.has(url)) {
    // No transformation needed for this module
    return result;
  }

  if (result.format === "commonjs") {
    const parsedUrl = new URL(result.responseURL ?? url);
    result.source ??= await readFile(parsedUrl);
  }

  const code = result.source;
  if (code) {
    const transformer = transformers.get(url);
    try {
      const moduleType = getModuleType(url, result.format);
      const transformedCode = transformer.transform(
        code.toString("utf8"),
        moduleType,
      );
      result.source = transformedCode?.code;
      result.shortCircuit = true;
    } catch (err) {
      console.warn(`Error transforming module ${url}:`, err);
    }
  }

  return result;
}
