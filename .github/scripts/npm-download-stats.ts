import { readFileSync, readdirSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const DD_SITE = process.env.DD_SITE ?? "us5.datadoghq.com";
const DD_SERIES_URL = `https://api.${DD_SITE}/api/v1/series`;

const MAX_MINORS_PER_MAJOR = 3;
const MAX_PATCHES_PER_MINOR = 3;

const PACKAGE_DIRS = ["js", "integrations/*"];

interface VersionEntry {
  version: string;
  downloads: number;
  major: number;
  minor: number;
  patch: number;
}

interface DatadogSeries {
  metric: string;
  type: "gauge";
  points: [number, number][];
  tags: string[];
}

const SEMVER_REGEX = /^(\d+)\.(\d+)\.(\d+)$/;

function discoverPackages(): Array<string> {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (args.length > 0) {
    return args;
  }

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const sdkRoot = resolve(scriptDir, "../..");

  const names: Array<string> = [];
  for (const pattern of PACKAGE_DIRS) {
    if (pattern.includes("*")) {
      const parent = resolve(sdkRoot, pattern.split("*")[0]);
      if (!existsSync(parent)) {
        continue;
      }
      for (const entry of readdirSync(parent, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
          continue;
        }
        const pkgFile = resolve(parent, entry.name, "package.json");
        if (existsSync(pkgFile)) {
          names.push(JSON.parse(readFileSync(pkgFile, "utf8")).name);
        }
      }
    } else {
      const pkgFile = resolve(sdkRoot, pattern, "package.json");
      if (existsSync(pkgFile)) {
        names.push(JSON.parse(readFileSync(pkgFile, "utf8")).name);
      }
    }
  }

  return names;
}

function parseVersions(downloads: Record<string, number>): Array<VersionEntry> {
  const entries: Array<VersionEntry> = [];

  for (const [version, count] of Object.entries(downloads)) {
    const match = SEMVER_REGEX.exec(version);
    if (!match) {
      continue;
    }
    entries.push({
      version,
      downloads: count,
      major: Number(match[1]),
      minor: Number(match[2]),
      patch: Number(match[3]),
    });
  }

  return entries;
}

function selectVersions(entries: Array<VersionEntry>): Array<VersionEntry> {
  const byMajor = new Map<number, Array<VersionEntry>>();
  for (const entry of entries) {
    const list = byMajor.get(entry.major) ?? [];
    list.push(entry);
    byMajor.set(entry.major, list);
  }

  const selected: Array<VersionEntry> = [];

  for (const [, majorEntries] of [...byMajor.entries()].sort(
    ([a], [b]) => a - b,
  )) {
    const byMinor = new Map<number, Array<VersionEntry>>();
    for (const entry of majorEntries) {
      const list = byMinor.get(entry.minor) ?? [];
      list.push(entry);
      byMinor.set(entry.minor, list);
    }

    const topMinors = [...byMinor.entries()]
      .sort(([a], [b]) => b - a)
      .slice(0, MAX_MINORS_PER_MAJOR);

    for (const [, minorEntries] of topMinors) {
      const topPatches = minorEntries
        .sort((a, b) => b.patch - a.patch)
        .slice(0, MAX_PATCHES_PER_MINOR);
      selected.push(...topPatches);
    }
  }

  return selected.sort((a, b) => {
    if (a.major !== b.major) return a.major - b.major;
    if (a.minor !== b.minor) return a.minor - b.minor;
    return a.patch - b.patch;
  });
}

function buildDatadogPayload(
  packageName: string,
  versions: Array<VersionEntry>,
  timestamp: number,
): Array<DatadogSeries> {
  return versions.map((v) => ({
    metric: "npm.downloads.weekly",
    type: "gauge",
    points: [[timestamp, v.downloads]],
    tags: [
      `package:${packageName}`,
      `version:${v.version}`,
      `major:${v.major}`,
      `minor:${v.major}.${v.minor}`,
    ],
  }));
}

async function fetchPackageStats(packageName: string): Promise<{
  package: string;
  downloads: Record<string, number>;
}> {
  const encoded = packageName.replace("/", "%2F");
  const url = `https://api.npmjs.org/versions/${encoded}/last-week`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `npm API returned ${response.status} for ${packageName}: ${await response.text()}`,
    );
  }
  return response.json() as Promise<{
    package: string;
    downloads: Record<string, number>;
  }>;
}

async function main() {
  const printOnly = process.argv.includes("--print");
  const ddApiKey = process.env.DD_API_KEY;
  if (!printOnly && !ddApiKey) {
    throw new Error(
      "DD_API_KEY environment variable is required (use --print to skip submission)",
    );
  }

  const packages = discoverPackages();
  if (packages.length === 0) {
    throw new Error("No packages found");
  }
  console.log(
    `Discovered ${packages.length} packages: ${packages.join(", ")}\n`,
  );

  const timestamp = Math.floor(Date.now() / 1000);
  const allSeries: Array<DatadogSeries> = [];

  for (const pkg of packages) {
    console.log(`Fetching 7-day download stats for ${pkg}...`);
    const data = await fetchPackageStats(pkg);
    const allVersions = parseVersions(data.downloads);
    console.log(
      `  Found ${allVersions.length} stable versions (excluded pre-release)`,
    );

    const selected = selectVersions(allVersions);
    console.log(
      `  Selected ${selected.length} versions (top ${MAX_MINORS_PER_MAJOR} minors x ${MAX_PATCHES_PER_MINOR} patches per major):`,
    );
    for (const v of selected) {
      console.log(
        `    ${v.version.padEnd(10)} ${v.downloads.toLocaleString().padStart(10)} downloads`,
      );
    }

    allSeries.push(...buildDatadogPayload(pkg, selected, timestamp));
    console.log();
  }

  const payload = { series: allSeries };

  if (printOnly) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`Submitting ${allSeries.length} metrics to Datadog...`);
  const ddResponse = await fetch(DD_SERIES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "DD-API-KEY": ddApiKey!,
    },
    body: JSON.stringify(payload),
  });

  if (!ddResponse.ok) {
    throw new Error(
      `Datadog API returned ${ddResponse.status}: ${await ddResponse.text()}`,
    );
  }

  console.log("Successfully submitted metrics to Datadog");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
