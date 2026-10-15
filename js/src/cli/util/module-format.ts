import fs from "node:fs";
import path from "node:path";

export type NodeModuleFormat = "esm" | "cjs";

export function detectModuleFormat(fileName: string): NodeModuleFormat {
  if (fileName.endsWith(".mjs")) {
    return "esm";
  }
  if (fileName.endsWith(".cjs")) {
    return "cjs";
  }

  let dir = path.dirname(path.resolve(fileName));
  while (dir !== path.dirname(dir)) {
    const pkgPath = path.join(dir, "package.json");
    try {
      const pkgContent = fs.readFileSync(pkgPath, "utf-8");
      const pkg = JSON.parse(pkgContent) as { type?: string };
      if (pkg.type === "module") {
        return "esm";
      }
      if (pkg.type === "commonjs") {
        return "cjs";
      }
      // Unknown type: keep searching parent directories.
    } catch {
      // Continue searching up the directory tree.
    }
    dir = path.dirname(dir);
  }

  return "cjs";
}
