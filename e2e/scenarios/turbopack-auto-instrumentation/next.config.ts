import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const require = createRequire(import.meta.url);
const scenarioDir = path.dirname(fileURLToPath(import.meta.url));
const packageDirs = [
  path.dirname(require.resolve("next/package.json")),
  path.dirname(require.resolve("braintrust/package.json")),
].map((packageDir) => fs.realpathSync(packageDir));

let turbopackRoot = scenarioDir;
for (const packageDir of packageDirs) {
  while (true) {
    const relativeToPackage = path.relative(turbopackRoot, packageDir);
    if (
      !relativeToPackage.startsWith("..") &&
      !path.isAbsolute(relativeToPackage)
    ) {
      break;
    }

    const parent = path.dirname(turbopackRoot);
    if (parent === turbopackRoot) {
      break;
    }
    turbopackRoot = parent;
  }
}

const nextConfig: NextConfig = {
  turbopack: {
    root: turbopackRoot,
    rules: {
      // Apply the loader to all JS/MJS/CJS files from node_modules.
      // condition: "foreign" restricts the rule to third-party packages only.
      "*.{js,mjs,cjs}": {
        condition: "foreign",
        loaders: [{ loader: require.resolve("braintrust/webpack-loader") }],
      },
    },
  },
};

export default nextConfig;
