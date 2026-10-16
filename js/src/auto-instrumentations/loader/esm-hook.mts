/**
 * ESM loader hook for auto-instrumentation.
 * This is used by Node.js --import to transform ES modules at load time.
 */

import { debugLogger } from "../../debug-logger.js";

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
  const filePath = url.startsWith("file:") ? fileURLToPath(url) : url;
  const resolvedModule = moduleDetailsFromPath(filePath.split("/").join(sep));
  if (!resolvedModule) return result;

  const packageInfo = getPackageInfo(resolvedModule.basedir);
  const packageName = packageInfo?.name ?? resolvedModule.name;
  const modulePath = resolvedModule.path.replace(/\\/g, "/");
  const specialCase = isSpecialCaseTarget(packageName, modulePath);
  const transformer =
    !specialCase && packageInfo?.version
      ? matcher.getTransformer(packageName, packageInfo.version, modulePath)
      : undefined;
  if (!specialCase && !transformer) return result;

  // Node may omit CommonJS source; only read it for an instrumentation target.
  if (result.format === "commonjs") {
    result.source ??= await readFile(new URL(result.responseURL ?? url));
  }
  if (!result.source) return result;
  const source = result.source.toString("utf8");

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
      debugLogger.warn(`Error transforming module ${url}:`, err);
    }
  }
  return result;
}
