import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const [path, requestedMode, option] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(path, "utf8"));

if (requestedMode !== "stable" && requestedMode !== "prerelease") {
  throw new Error(`Unknown requested release mode: ${requestedMode}`);
}
if (manifest.mode !== requestedMode) {
  throw new Error(
    `Requested a ${requestedMode} release, but the manifest specifies ${manifest.mode}.`,
  );
}

for (const pkg of manifest.packages) {
  let channel = "rc";
  if (requestedMode === "stable") {
    const response = await fetch(
      `https://registry.npmjs.org/-/package/${encodeURIComponent(pkg.name)}/dist-tags`,
    );
    if (!response.ok && response.status !== 404) {
      throw new Error(
        `Cannot read npm tags for ${pkg.name}: ${response.status}`,
      );
    }

    const tags = response.ok ? await response.json() : {};
    const version = stableVersion(pkg.version);
    const major = Number(version.split(".")[0]);
    const latest = tags.latest && stableVersion(tags.latest);
    channel =
      latest && Number(latest.split(".")[0]) > major
        ? `latest-${major}`
        : "latest";

    const current = tags[channel];
    if (
      current &&
      stableVersion(current).localeCompare(version, "en", { numeric: true }) > 0
    ) {
      throw new Error(
        `Cannot publish ${pkg.name}@${pkg.version} to ${channel}: the tag already points to ${current}.`,
      );
    }
  } else if (
    !/^\d+\.\d+\.\d+-rc\.[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*$/.test(pkg.version)
  ) {
    throw new Error(
      `Expected an RC snapshot for ${pkg.name}, received ${pkg.version}`,
    );
  }

  if (option === "--check") {
    if (pkg.channel !== channel || pkg.registries.npm.channel !== channel) {
      throw new Error(
        `The approved npm tag for ${pkg.name}@${pkg.version} was ${pkg.channel}. It now needs ${channel}. Start a new release run for approval.`,
      );
    }

    const response = await fetch(
      `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.version)}`,
    );
    if (response.status === 404) continue;
    if (!response.ok) {
      throw new Error(
        `Cannot read npm version ${pkg.name}@${pkg.version}: ${response.status}`,
      );
    }

    if (basename(pkg.tarball_asset) !== pkg.tarball_asset) {
      throw new Error(`Invalid tarball filename: ${pkg.tarball_asset}`);
    }
    const tarball = readFileSync(join(dirname(path), pkg.tarball_asset));
    const integrity = createHash("sha512").update(tarball).digest("base64");
    const { dist } = await response.json();
    if (dist.integrity !== `sha512-${integrity}`) {
      throw new Error(
        `${pkg.name}@${pkg.version} is already published with a different tarball.`,
      );
    }
  } else {
    pkg.label = `${pkg.name} (npm tag ${channel})`;
    pkg.channel = channel;
    pkg.registries.npm.channel = channel;
  }
}

if (option !== "--check") {
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

function stableVersion(version) {
  const match = /^(\d+\.\d+\.\d+)(?:\+[\w.-]+)?$/.exec(version);
  if (!match) {
    throw new Error(`Expected a stable npm version, received ${version}`);
  }
  return match[1];
}
