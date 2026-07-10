import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  PUBLISHABLE_PACKAGES,
  appendSummary,
  orderPackagesForPublish,
  packageArtifactBase,
  parseArgs,
  readPackage,
  repoPath,
} from "./_shared.mjs";

const args = parseArgs();
const outputDir = args["output-dir"] ?? "artifacts/release-packages";
const manifestPath = args.manifest;
const reportPath =
  args.report ?? path.posix.join(outputDir, "pack-report.json");

const targets = getTargets(manifestPath);
const absoluteOutputDir = repoPath(outputDir);
mkdirSync(absoluteOutputDir, { recursive: true });

const artifacts = [];
for (const target of targets) {
  const packDir = mkdtempSync(path.join(os.tmpdir(), "braintrust-pack-"));
  try {
    execFileSync("pnpm", ["pack", "--pack-destination", packDir], {
      cwd: repoPath(target.dir),
      stdio: "inherit",
    });

    const packedTarballs = readdirSync(packDir).filter((file) =>
      file.endsWith(".tgz"),
    );
    if (packedTarballs.length !== 1) {
      throw new Error(
        `Expected pnpm pack for ${target.name} to create one tarball, found ${packedTarballs.length}`,
      );
    }

    const tarballAsset =
      target.tarball_asset ??
      `${packageArtifactBase(target.name, target.version)}.tgz`;
    const sbomAsset =
      target.sbom_asset ??
      `${packageArtifactBase(target.name, target.version)}.sbom.json`;
    const tarballPath = path.join(absoluteOutputDir, tarballAsset);
    const sbomPath = path.join(absoluteOutputDir, sbomAsset);

    renameSync(path.join(packDir, packedTarballs[0]), tarballPath);
    execFileSync(
      "pnpm",
      [
        "--dir",
        repoPath(target.dir),
        "sbom",
        "--sbom-format",
        "cyclonedx",
        "--prod",
        "--out",
        sbomPath,
      ],
      { stdio: "inherit" },
    );

    artifacts.push({
      name: target.name,
      dir: target.dir,
      version: target.version,
      tarball: path.relative(repoPath(), tarballPath),
      sbom: path.relative(repoPath(), sbomPath),
    });
  } finally {
    rmSync(packDir, { force: true, recursive: true });
  }
}

writeFileSync(
  repoPath(reportPath),
  `${JSON.stringify({ artifacts }, null, 2)}\n`,
  "utf8",
);
console.log(`Packed ${artifacts.length} package(s) into ${outputDir}`);
appendSummary(
  `## Packed publishable packages\n\n${artifacts
    .map(
      (entry) =>
        `- ${entry.name}@${entry.version}: ${entry.tarball}, ${entry.sbom}`,
    )
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
  return orderPackagesForPublish(manifest.packages ?? []).map((pkg) =>
    readPackageInfo(pkg.dir, pkg.name, pkg),
  );
}

function readPackageInfo(relativeDir, expectedName, manifestEntry = {}) {
  const manifest = readPackage(relativeDir);

  if (manifest.name !== expectedName) {
    throw new Error(
      `Expected ${relativeDir} to be ${expectedName}, found ${manifest.name}`,
    );
  }

  return {
    ...manifestEntry,
    dir: relativeDir,
    name: manifest.name,
    version: manifest.version,
  };
}
