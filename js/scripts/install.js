"use strict";

// Postinstall script for the `bt` CLI binary.
//
// The native binary ships in a per-platform `@braintrust/bt-*` package listed
// in `optionalDependencies`; npm/pnpm install only the one matching the host.
// If a package manager is run with `--no-optional`, `--ignore-optional`, or
// `--omit=optional`, none of those packages get installed and `bt` would be
// unusable. As a workaround, we manually fetch the matching tarball from the
// npm registry and extract the binary so the launcher can find it.

const fs = require("node:fs");
const https = require("node:https");
const path = require("node:path");
const zlib = require("node:zlib");

const helper = require("./bt-helper");
const pkg = require("../package.json");

if (process.env.BT_SKIP_DOWNLOAD === "1") {
  console.log(
    "bt: skipping post-install binary download because BT_SKIP_DOWNLOAD=1 is set.",
  );
  process.exit(0);
}

const { packageName, subpath } = helper.getDistributionForThisPlatform();

if (packageName === undefined) {
  // Don't fail the install; the launcher will surface the unsupported-platform
  // error if/when the user actually tries to run `bt`.
  console.error(
    `bt: no prebuilt binary available for ${process.platform}-${process.arch}; the bt CLI will not be available.`,
  );
  process.exit(0);
}

try {
  require.resolve(`${packageName}/${subpath}`);
  // Optional dependency was installed successfully. Nothing to do.
  process.exit(0);
} catch (e) {
  // Fall through to the manual download path below.
  console.log(
    `bt: failed to locate the "${packageName}" package after installation.

This can happen if you use an option to disable optional dependencies during installation, like "--no-optional", "--ignore-optional", or "--omit=optional". The "braintrust" package uses the "optionalDependencies" package.json feature to install the correct bt binary for your platform and operating system. This post-install script will now try to work around that by manually downloading the bt binary from the npm registry. If this fails, you need to remove the "--no-optional", "--ignore-optional", and "--omit=optional" flags for bt to work.`,
  );
}

const version = (pkg.optionalDependencies || {})[packageName];
if (!version) {
  // Don't fail the parent install: the SDK works without `bt`, and the
  // launcher errors clearly if it's actually invoked.
  console.error(
    `bt: cannot determine which version of "${packageName}" to download — it is not listed in the "braintrust" package's optionalDependencies. The bt CLI will not be available; the rest of the braintrust SDK is unaffected.`,
  );
  process.exit(0);
}

function fetchBuffer(url, redirectsRemaining = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (response) => {
        const { statusCode = 0, headers } = response;
        if (statusCode >= 200 && statusCode < 300) {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () => resolve(Buffer.concat(chunks)));
          response.on("error", reject);
          return;
        }
        if (
          statusCode >= 300 &&
          statusCode < 400 &&
          headers.location &&
          redirectsRemaining > 0
        ) {
          response.resume();
          fetchBuffer(headers.location, redirectsRemaining - 1).then(
            resolve,
            reject,
          );
          return;
        }
        response.resume();
        reject(
          new Error(
            `npm registry responded with status code ${statusCode} when downloading ${url}`,
          ),
        );
      })
      .on("error", reject);
  });
}

// Extracts a single file from an uncompressed tar archive. Tar archives are
// organized in 512-byte blocks: a header block (file name in bytes 0-99,
// file size in bytes 124-135 as an octal string) followed by data blocks
// padded out to the next multiple of 512.
function extractFileFromTarball(tarball, target) {
  let offset = 0;
  while (offset + 512 <= tarball.length) {
    const header = tarball.subarray(offset, offset + 512);
    offset += 512;
    const fileName = header.toString("utf-8", 0, 100).replace(/\0.*/g, "");
    if (!fileName) break;
    const fileSize = parseInt(
      header.toString("utf-8", 124, 136).replace(/\0.*/g, ""),
      8,
    );
    if (fileName === target) {
      return tarball.subarray(offset, offset + fileSize);
    }
    offset = (offset + fileSize + 511) & ~511;
  }
  return null;
}

async function downloadFallback() {
  // npm tarball URLs look like:
  //   https://registry.npmjs.org/<scope>/<name>/-/<name>-<version>.tgz
  // where <name> is the unscoped package name.
  const tarballName = packageName.split("/").pop();
  const url = `https://registry.npmjs.org/${packageName}/-/${tarballName}-${version}.tgz`;
  console.log(`bt: downloading ${packageName}@${version} from ${url}`);

  const gzipped = await fetchBuffer(url);
  const tarball = zlib.gunzipSync(gzipped);
  const binary = extractFileFromTarball(tarball, `package/${subpath}`);

  if (!binary) {
    throw new Error(
      `could not find "package/${subpath}" inside ${packageName}@${version} tarball`,
    );
  }

  const fallbackBinaryPath = helper.getFallbackBinaryPath();
  fs.mkdirSync(path.dirname(fallbackBinaryPath), { recursive: true });
  fs.writeFileSync(fallbackBinaryPath, binary);
  fs.chmodSync(fallbackBinaryPath, 0o755);
  console.log(`bt: installed fallback binary at ${fallbackBinaryPath}`);
}

downloadFallback().catch((err) => {
  // Don't fail the parent install: airgapped/proxied CI may not reach the
  // npm registry, and the SDK works without `bt`.
  console.error(
    `bt: failed to download fallback binary for ${packageName}@${version}: ${err.message}
The bt CLI will not be available; the rest of the braintrust SDK is unaffected.`,
  );
  process.exit(0);
});
