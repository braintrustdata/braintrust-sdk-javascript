import { extname, sep } from "node:path";
import moduleDetailsFromPath from "module-details-from-path";
import { Transformer } from "../orchestrion-js/transformer";
import type { InstrumentationMatcher } from "../orchestrion-js";
import { getPackageInfo } from "../loader/get-package-info";
import { applySpecialCasePatch } from "../loader/special-case-patches";

/** Shared transformation pipeline for bundler plugins and webpack loaders. */
export function transformBundledModule(
  code: string,
  filePath: string,
  matcher: InstrumentationMatcher,
  browser: boolean,
): { code: string; map?: string | null } | null {
  // Vite/Rollup can use forward slashes on Windows; module-details-from-path
  // expects platform separators.
  const details = moduleDetailsFromPath(filePath.split("/").join(sep));
  if (!details) return null;

  // npm aliases use a different directory name, but retain the canonical name
  // in package.json. Both bundler entrypoints must match that identity.
  const packageInfo = getPackageInfo(details.basedir);
  const packageName = packageInfo?.name ?? details.name;
  const modulePath = details.path.replace(/\\/g, "/");
  const ext = extname(filePath);
  const isModule =
    ext === ".mjs" ||
    ext === ".ts" ||
    ext === ".tsx" ||
    (ext === ".js" && (code.includes("export ") || code.includes("import ")));
  const format = isModule ? "esm" : "cjs";

  const patched = applySpecialCasePatch({
    packageName,
    modulePath,
    source: code,
    format,
    browser,
  });
  if (patched !== null) {
    const result = new Transformer(
      packageName,
      packageInfo?.version ?? "",
      modulePath,
      [],
    ).transform(patched, format, "braintrust/auto");
    // The patch changes source positions before the transformer sees the file.
    return result ? { code: result.code } : { code: patched };
  }
  if (!packageInfo?.version) return null;

  const transformer = matcher.getTransformer(
    packageName,
    packageInfo.version,
    modulePath,
  );
  return transformer
    ? transformer.transform(code, format, "braintrust/auto")
    : null;
}
