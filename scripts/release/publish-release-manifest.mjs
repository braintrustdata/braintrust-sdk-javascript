import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import {
  isPublishedToNpm,
  orderPackagesForPublish,
  parseArgs,
  readPackage,
  repoPath,
} from "./_shared.mjs";

const args = parseArgs();
const manifestPath = args.manifest ?? ".release-manifest.json";
const npmTag = args.tag;

const manifest = JSON.parse(readFileSync(repoPath(manifestPath), "utf8"));
const packages = orderPackagesForPublish(manifest.packages ?? []);

if (packages.length === 0) {
  console.log(`No packages to publish from ${manifestPath}.`);
  process.exit(0);
}

for (const pkg of packages) {
  const packageDir = repoPath(pkg.dir);
  const packageJson = readPackage(pkg.dir);
  const publishArgs = ["publish"];

  if (packageJson.publishConfig?.access) {
    publishArgs.push("--access", packageJson.publishConfig.access);
  }

  if (npmTag) {
    publishArgs.push("--tag", npmTag);
  }

  if (isPublishedToNpm(packageJson.name, packageJson.version)) {
    console.log(
      `${packageJson.name}@${packageJson.version} is already published; skipping npm publish.`,
    );
    continue;
  }

  console.log(
    `Publishing ${packageJson.name}@${packageJson.version} from ${pkg.dir} with npm`,
  );

  execFileSync("npm", publishArgs, {
    cwd: packageDir,
    stdio: "inherit",
  });
}
