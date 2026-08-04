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
const PACKAGING_PNPM_VERSION = "11.9.0";

const targets = getTargets(manifestPath);
const absoluteOutputDir = repoPath(outputDir);
mkdirSync(absoluteOutputDir, { recursive: true });

const artifacts = targets.map(packPackage);

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

function packPackage(target) {
  const packDir = mkdtempSync(path.join(os.tmpdir(), "braintrust-pack-"));
  try {
    runPackagingPnpm(["pack", "--pack-destination", packDir], {
      cwd: repoPath(target.dir),
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
    for (const asset of [tarballAsset, sbomAsset]) {
      if (path.basename(asset) !== asset) {
        throw new Error(`Release artifact must be a basename: ${asset}`);
      }
    }

    const tarballPath = path.join(absoluteOutputDir, tarballAsset);
    const sbomPath = path.join(absoluteOutputDir, sbomAsset);
    renameSync(path.join(packDir, packedTarballs[0]), tarballPath);
    runPackagingPnpm(
      [
        "--filter",
        target.name,
        "sbom",
        "--sbom-format",
        "cyclonedx",
        "--prod",
        "--out",
        sbomPath,
      ],
      { cwd: repoPath() },
    );

    const sbom = JSON.parse(readFileSync(sbomPath, "utf8"));
    const rootComponent = sbom.metadata?.component;
    const rootPackageName = rootComponent?.group
      ? `${rootComponent.group}/${rootComponent.name}`
      : rootComponent?.name;
    if (
      rootPackageName !== target.name ||
      rootComponent?.version !== target.version
    ) {
      throw new Error(
        `Expected SBOM for ${target.name}@${target.version}, found ${rootPackageName}@${rootComponent?.version}`,
      );
    }

    return {
      name: target.name,
      dir: target.dir,
      version: target.version,
      tarball: path.relative(repoPath(), tarballPath),
      sbom: path.relative(repoPath(), sbomPath),
    };
  } finally {
    rmSync(packDir, { force: true, recursive: true });
  }
}

function getTargets(maybeManifestPath) {
  if (!maybeManifestPath) {
    return PUBLISHABLE_PACKAGES.map((pkg) =>
      readPackageInfo(pkg.dir, pkg.name),
    );
  }

  const releaseManifest = JSON.parse(
    readFileSync(repoPath(maybeManifestPath), "utf8"),
  );
  return orderPackagesForPublish(releaseManifest.packages ?? []).map((pkg) =>
    readPackageInfo(pkg.dir, pkg.name, pkg),
  );
}

function readPackageInfo(relativeDir, expectedName, releasePackage = {}) {
  const packageJson = readPackage(relativeDir);

  if (packageJson.name !== expectedName) {
    throw new Error(
      `Expected ${relativeDir} to be ${expectedName}, found ${packageJson.name}`,
    );
  }

  return {
    ...releasePackage,
    dir: relativeDir,
    name: packageJson.name,
    version: packageJson.version,
  };
}

function runPackagingPnpm(pnpmArgs, options) {
  execFileSync(
    "corepack",
    [`pnpm@${PACKAGING_PNPM_VERSION}`, "--pm-on-fail=ignore", ...pnpmArgs],
    {
      ...options,
      env: {
        ...process.env,
        COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
      },
      stdio: "inherit",
    },
  );
}
