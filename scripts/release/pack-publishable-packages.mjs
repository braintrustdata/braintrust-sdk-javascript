import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  PUBLISHABLE_PACKAGES,
  appendSummary,
  parseArgs,
  repoPath,
} from "./_shared.mjs";

const args = parseArgs();
const outputDir = args["output-dir"] ?? "artifacts/release-packages";
const manifestPath = args.manifest;
const reportPath =
  args.report ?? path.posix.join(outputDir, "pack-report.json");

const targets = getTargets(manifestPath);
mkdirSync(repoPath(outputDir), { recursive: true });

const tarballs = [];
for (const target of targets) {
  const relativeOutputDir = path.posix.relative(target.dir, outputDir);
  const tarball = execFileSync(
    "npm",
    ["pack", "--pack-destination", relativeOutputDir],
    {
      cwd: repoPath(target.dir),
      encoding: "utf8",
    },
  ).trim();

  tarballs.push({
    name: target.name,
    dir: target.dir,
    version: target.version,
    tarball,
  });
}

writeFileSync(
  repoPath(reportPath),
  `${JSON.stringify({ tarballs }, null, 2)}\n`,
  "utf8",
);
console.log(`Packed ${tarballs.length} package(s) into ${outputDir}`);
appendSummary(
  `## Packed publishable packages\n\n${tarballs
    .map((entry) => `- ${entry.name}@${entry.version}: ${entry.tarball}`)
    .join("\n")}`,
);

function getTargets(maybeManifestPath) {
  if (!maybeManifestPath) {
    return PUBLISHABLE_PACKAGES.map((pkg) =>
      readPackageInfo(pkg.dir, pkg.name),
    );
  }

  const manifest = JSON.parse(
    readFileSync(repoPath(maybeManifestPath), "utf8"),
  );
  return manifest.packages.map((pkg) => readPackageInfo(pkg.dir, pkg.name));
}

function readPackageInfo(relativeDir, expectedName) {
  const manifest = JSON.parse(
    readFileSync(repoPath(relativeDir, "package.json"), "utf8"),
  );

  if (manifest.name !== expectedName) {
    throw new Error(
      `Expected ${relativeDir} to be ${expectedName}, found ${manifest.name}`,
    );
  }

  return {
    dir: relativeDir,
    name: manifest.name,
    version: manifest.version,
  };
}
