import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withBraintrust } from "braintrust/next";

const require = createRequire(import.meta.url);
const scenarioDir = path.dirname(fileURLToPath(import.meta.url));
const nextVersion = require("next/package.json").version;
const packageDirs = [
  path.dirname(require.resolve("next/package.json")),
  path.dirname(require.resolve("braintrust/package.json")),
].map((packageDir) => fs.realpathSync(packageDir));

// Turbopack refuses to compile files outside its root. In this e2e fixture,
// Next and the local braintrust package can resolve through workspace/cache
// symlinks, so widen the root until both package realpaths are included.
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

const nextMajorVersion = Number.parseInt(nextVersion.split(".")[0] ?? "", 10);
const nextConfig =
  Number.isFinite(nextMajorVersion) && nextMajorVersion >= 15
    ? {
        turbopack: {
          root: turbopackRoot,
        },
      }
    : {
        experimental: {
          turbo: {
            root: turbopackRoot,
          },
        },
      };

export default withBraintrust(nextConfig);
