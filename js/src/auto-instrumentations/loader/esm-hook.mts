/**
 * ESM loader hook for auto-instrumentation.
 * This is used by Node.js --import to transform ES modules at load time.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extname, sep } from "node:path";
import {
  create,
  type InstrumentationConfig,
} from "@apm-js-collab/code-transformer";
import moduleDetailsFromPath from "module-details-from-path";
import { getPackageName, getPackageVersion } from "./get-package-version.js";

let instrumentator: any;
let packages: Set<string>;
let transformers: Map<string, any> = new Map();

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
    if (!packages?.has(packageName)) {
      return url;
    }

    const version = getPackageVersion(resolvedModule.basedir);
    // Normalize module path for WASM transformer (expects forward slashes)
    const normalizedModulePath = resolvedModule.path.replace(/\\/g, "/");

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
    } finally {
      transformer.free();
    }
  }

  return result;
}
