"use strict";

// Shared helpers for locating the `bt` binary. Used by both `bin/bt`
// (the runtime launcher) and `scripts/install.js` (the postinstall
// fallback downloader).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const BINARY_DISTRIBUTIONS = [
  { packageName: "@braintrust/bt-darwin-arm64", subpath: "bin/bt" },
  { packageName: "@braintrust/bt-darwin-x64", subpath: "bin/bt" },
  { packageName: "@braintrust/bt-linux-arm64", subpath: "bin/bt" },
  { packageName: "@braintrust/bt-linux-x64", subpath: "bin/bt" },
  { packageName: "@braintrust/bt-linux-x64-musl", subpath: "bin/bt" },
  { packageName: "@braintrust/bt-win32-arm64", subpath: "bin/bt.exe" },
  { packageName: "@braintrust/bt-win32-x64", subpath: "bin/bt.exe" },
];

function detectLibc() {
  if (process.platform !== "linux") return null;
  try {
    const report = process.report && process.report.getReport();
    if (report && report.header && report.header.glibcVersionRuntime) {
      return "glibc";
    }
    return "musl";
  } catch {
    return "glibc";
  }
}

function binaryName() {
  return process.platform === "win32" ? "bt.exe" : "bt";
}

function getDistributionForThisPlatform() {
  const arch = os.arch();
  const platform = os.platform();
  const subpath = `bin/${binaryName()}`;

  let packageName;
  if (platform === "darwin") {
    if (arch === "arm64") packageName = "@braintrust/bt-darwin-arm64";
    else if (arch === "x64") packageName = "@braintrust/bt-darwin-x64";
  } else if (platform === "linux") {
    if (arch === "arm64") {
      packageName = "@braintrust/bt-linux-arm64";
    } else if (arch === "x64") {
      packageName =
        detectLibc() === "musl"
          ? "@braintrust/bt-linux-x64-musl"
          : "@braintrust/bt-linux-x64";
    }
  } else if (platform === "win32") {
    if (arch === "arm64") packageName = "@braintrust/bt-win32-arm64";
    else if (arch === "x64") packageName = "@braintrust/bt-win32-x64";
  }

  return { packageName, subpath };
}

function throwUnsupportedPlatformError() {
  throw new Error(
    `Unsupported operating system or architecture! The bt CLI does not work on ${process.platform}-${process.arch}.

bt supports:
- macOS (darwin) on arm64 and x64
- Linux on arm64 and x64 (glibc and musl)
- Windows on arm64 and x64`,
  );
}

// Constructed indirectly so bundlers (e.g. @vercel/nft) don't statically
// detect the fallback binary path as an asset to trace.
function getFallbackBinaryPath() {
  const parts = [__dirname, binaryName()];
  return path.resolve(...parts);
}

function getBinaryPath() {
  if (process.env.BT_BINARY_PATH) {
    return process.env.BT_BINARY_PATH;
  }

  const { packageName, subpath } = getDistributionForThisPlatform();

  if (packageName === undefined) {
    throwUnsupportedPlatformError();
  }

  // Prefer the optional dep so a stale fallback from a prior
  // `--omit=optional` install can't shadow a newer optional dep on upgrade.
  try {
    return require.resolve(`${packageName}/${subpath}`);
  } catch (e) {
    const fallbackBinaryPath = getFallbackBinaryPath();
    if (fs.existsSync(fallbackBinaryPath)) {
      return fallbackBinaryPath;
    }

    const otherInstalled = BINARY_DISTRIBUTIONS.find((dist) => {
      try {
        require.resolve(`${dist.packageName}/${dist.subpath}`);
        return true;
      } catch {
        return false;
      }
    });

    // Error messages inspired by esbuild:
    // https://github.com/evanw/esbuild/blob/f3d535262e3998d845d0f102b944ecd5a9efda57/lib/npm/node-platform.ts#L150
    if (otherInstalled) {
      throw new Error(
        `bt binary for this platform/architecture not found!

The "${otherInstalled.packageName}" package is installed, but for the current platform you should have the "${packageName}" package installed instead. This usually happens if "braintrust" is installed on one platform (for example macOS or Windows) and the "node_modules" folder is then reused on another (for example Linux in Docker).

To fix this, avoid copying the "node_modules" folder, and instead freshly install your dependencies on the target system. You can also configure your package manager to install the right package. For example, yarn has the "supportedArchitectures" feature: https://yarnpkg.com/configuration/yarnrc/#supportedArchitecture.`,
      );
    }

    throw new Error(
      `bt binary for this platform/architecture not found!

It seems like none of the "braintrust" package's optional dependencies got installed. Please make sure your package manager is configured to install optional dependencies. If you are using npm, don't set the "--no-optional", "--ignore-optional", or "--omit=optional" flags. The "braintrust" package needs the "optionalDependencies" feature in order to install the bt binary.`,
    );
  }
}

module.exports = {
  BINARY_DISTRIBUTIONS,
  binaryName,
  getBinaryPath,
  getDistributionForThisPlatform,
  getFallbackBinaryPath,
  throwUnsupportedPlatformError,
};
