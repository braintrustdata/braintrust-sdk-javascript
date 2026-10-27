import { readFileSync } from "node:fs";
import { join } from "node:path";

interface PackageInfo {
  name?: string;
  version?: string;
}

const packages = new Map<string, PackageInfo>();

export function getPackageInfo(baseDir: string): PackageInfo | undefined {
  const cached = packages.get(baseDir);
  if (cached) return cached;

  try {
    // readFileSync follows directory symlinks, including npm package aliases.
    const json = JSON.parse(
      readFileSync(join(baseDir, "package.json"), "utf8"),
    );
    const info = {
      name: typeof json?.name === "string" ? json.name : undefined,
      version: typeof json?.version === "string" ? json.version : undefined,
    };
    packages.set(baseDir, info);
    return info;
  } catch {
    return undefined;
  }
}
