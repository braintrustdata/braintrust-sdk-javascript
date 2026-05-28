#!/usr/bin/env node
"use strict";

// Launcher for the `bt` CLI. The native binary ships in a per-platform
// package (`@braintrust/bt-<platform>`) listed as an optionalDependency of
// `braintrust`; npm/pnpm install only the one matching the host. This script
// resolves that binary and forwards argv + exit code.

const { spawnSync } = require("node:child_process");

const PLATFORM_PACKAGES = {
  "darwin-arm64": "@braintrust/bt-darwin-arm64",
  "darwin-x64": "@braintrust/bt-darwin-x64",
  "linux-arm64": "@braintrust/bt-linux-arm64",
  "linux-x64-glibc": "@braintrust/bt-linux-x64",
  "linux-x64-musl": "@braintrust/bt-linux-x64-musl",
  "win32-arm64": "@braintrust/bt-win32-arm64",
  "win32-x64": "@braintrust/bt-win32-x64",
};

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

function platformKey() {
  const { platform, arch } = process;
  if (platform === "linux" && arch === "x64") {
    return `linux-x64-${detectLibc()}`;
  }
  return `${platform}-${arch}`;
}

function binaryName() {
  return process.platform === "win32" ? "bt.exe" : "bt";
}

function resolveBinary() {
  const pkg = PLATFORM_PACKAGES[platformKey()];
  if (!pkg) {
    throw new Error(
      `No prebuilt bt binary for ${process.platform}-${process.arch}. ` +
        `Supported platforms: ${Object.keys(PLATFORM_PACKAGES).join(", ")}.`,
    );
  }
  try {
    return require.resolve(`${pkg}/bin/${binaryName()}`);
  } catch (err) {
    throw new Error(
      `Failed to locate the bt binary from "${pkg}". It is an optional ` +
        `dependency of "braintrust"; reinstall your dependencies to fetch ` +
        `it (${err.message}).`,
    );
  }
}

try {
  const result = spawnSync(resolveBinary(), process.argv.slice(2), {
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.signal) process.kill(process.pid, result.signal);
  process.exit(result.status ?? 1);
} catch (err) {
  console.error(`bt: ${err.message}`);
  process.exit(1);
}
