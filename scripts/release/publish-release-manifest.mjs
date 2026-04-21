import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { parseArgs, readPackage, repoPath } from "./_shared.mjs";

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

  console.log(
    `Publishing ${packageJson.name}@${packageJson.version} from ${pkg.dir} with npm`,
  );

  execFileSync("npm", publishArgs, {
    cwd: packageDir,
    stdio: "inherit",
  });
}

function orderPackagesForPublish(packages) {
  const packageMap = new Map(
    packages.map((pkg) => [
      pkg.name,
      { ...pkg, manifest: readPackage(pkg.dir) },
    ]),
  );
  const visiting = new Set();
  const visited = new Set();
  const ordered = [];

  for (const pkg of packageMap.values()) {
    visit(pkg);
  }

  return ordered.map(({ manifest: _manifest, ...pkg }) => pkg);

  function visit(pkg) {
    if (visited.has(pkg.name)) {
      return;
    }

    if (visiting.has(pkg.name)) {
      throw new Error(
        `Detected a publish dependency cycle involving ${pkg.name}`,
      );
    }

    visiting.add(pkg.name);

    for (const dependencyName of getWorkspaceReleaseDependencies(
      pkg.manifest,
    )) {
      const dependency = packageMap.get(dependencyName);
      if (dependency) {
        visit(dependency);
      }
    }

    visiting.delete(pkg.name);
    visited.add(pkg.name);
    ordered.push(pkg);
  }
}

function getWorkspaceReleaseDependencies(manifest) {
  const dependencyNames = new Set();

  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "devDependencies",
  ]) {
    for (const dependencyName of Object.keys(manifest[field] ?? {})) {
      dependencyNames.add(dependencyName);
    }
  }

  dependencyNames.delete(manifest.name);
  return dependencyNames;
}
