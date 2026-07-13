import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REPO_ROOT = path.resolve(__dirname, "../..");
const NPM_REGISTRY = "https://registry.npmjs.org/";
export const GITHUB_REPO_URL =
  "git+https://github.com/braintrustdata/braintrust-sdk-javascript.git";
export const DOCS_HOMEPAGE = "https://www.braintrust.dev/docs";

export const PUBLISHABLE_PACKAGES = [
  { dir: "js", name: "braintrust" },
  { dir: "integrations/browser-js", name: "@braintrust/browser" },
  { dir: "integrations/langchain-js", name: "@braintrust/langchain-js" },
  { dir: "integrations/openai-agents-js", name: "@braintrust/openai-agents" },
  { dir: "integrations/otel-js", name: "@braintrust/otel" },
  {
    dir: "integrations/templates-nunjucks",
    name: "@braintrust/templates-nunjucks-js",
  },
  { dir: "integrations/temporal-js", name: "@braintrust/temporal" },
  {
    dir: "integrations/vercel-ai-sdk",
    name: "@braintrust/vercel-ai-sdk",
  },
];

export const PRIVATE_WORKSPACE_PACKAGES = [
  {
    dir: "js/src/wrappers/vitest",
    name: "@braintrust/vitest-wrapper-tests",
  },
  { dir: "e2e", name: "@braintrust/js-e2e-tests" },
];

const PUBLISHABLE_PACKAGE_NAMES = PUBLISHABLE_PACKAGES.map((pkg) => pkg.name);
const PUBLISHABLE_PACKAGE_NAME_SET = new Set(PUBLISHABLE_PACKAGE_NAMES);
const PUBLISHABLE_PACKAGE_MAP = new Map(
  PUBLISHABLE_PACKAGES.map((pkg) => [pkg.name, pkg]),
);

export function repoPath(...segments) {
  return path.join(REPO_ROOT, ...segments);
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(repoPath(relativePath), "utf8"));
}

export function readPackage(relativeDir) {
  const manifest = readJson(path.posix.join(relativeDir, "package.json"));
  return {
    ...manifest,
    dir: relativeDir,
    packageJsonPath: repoPath(relativeDir, "package.json"),
    changelogPath: repoPath(relativeDir, "CHANGELOG.md"),
  };
}

export function getApprovedPackageByName(name) {
  return PUBLISHABLE_PACKAGE_MAP.get(name);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function writeGithubOutput(
  key,
  value,
  outputPath = process.env.GITHUB_OUTPUT,
) {
  if (!outputPath) {
    return;
  }

  const serialized = String(value ?? "");
  if (serialized.includes("\n")) {
    appendFileSync(outputPath, `${key}<<EOF\n${serialized}\nEOF\n`, "utf8");
    return;
  }

  appendFileSync(outputPath, `${key}=${serialized}\n`, "utf8");
}

export function appendSummary(markdown) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }

  appendFileSync(summaryPath, `${markdown.trimEnd()}\n`, "utf8");
}

export function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }

    const [rawKey, inlineValue] = token.slice(2).split("=", 2);
    if (inlineValue !== undefined) {
      args[rawKey] = inlineValue;
      continue;
    }

    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[rawKey] = true;
      continue;
    }

    args[rawKey] = next;
    index += 1;
  }
  return args;
}

function listImmediateChildDirectories(relativeBaseDir) {
  const absoluteBaseDir = repoPath(relativeBaseDir);
  if (!existsSync(absoluteBaseDir)) {
    return [];
  }

  return readdirSync(absoluteBaseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.posix.join(relativeBaseDir, entry.name));
}

export function listWorkspacePackageDirs() {
  const workspaceYaml = readFileSync(repoPath("pnpm-workspace.yaml"), "utf8");
  const patterns = [
    ...workspaceYaml.matchAll(/^\s*-\s+"?([^"\n]+)"?\s*$/gm),
  ].map((match) => match[1]);

  const includePatterns = patterns.filter(
    (pattern) => !pattern.startsWith("!"),
  );
  const ignorePatterns = patterns
    .filter((pattern) => pattern.startsWith("!"))
    .map((pattern) => pattern.slice(1));

  const discovered = new Set();

  for (const pattern of includePatterns) {
    if (pattern.endsWith("/*")) {
      for (const dir of listImmediateChildDirectories(pattern.slice(0, -2))) {
        if (existsSync(repoPath(dir, "package.json"))) {
          discovered.add(dir);
        }
      }
      continue;
    }

    if (existsSync(repoPath(pattern, "package.json"))) {
      discovered.add(pattern);
    }
  }

  return [...discovered].filter(
    (dir) =>
      !ignorePatterns.some((pattern) => matchesIgnorePattern(dir, pattern)),
  );
}

function matchesIgnorePattern(relativeDir, pattern) {
  if (pattern.endsWith("/**")) {
    const base = pattern.slice(0, -3);
    return relativeDir === base || relativeDir.startsWith(`${base}/`);
  }
  return relativeDir === pattern;
}

export function filterPublishableReleases(status) {
  return (status.releases ?? []).filter((release) =>
    PUBLISHABLE_PACKAGE_NAME_SET.has(release.name),
  );
}

export function getReleaseTag(name, version) {
  return `${name}@${version}`;
}

export function formatPackageList(packages) {
  return packages.map((pkg) => `- ${pkg.name}@${pkg.version}`).join("\n");
}

export function extractReleaseNotes(relativeDir, packageName, version) {
  const changelogPath = repoPath(relativeDir, "CHANGELOG.md");
  if (!existsSync(changelogPath)) {
    return `Published ${packageName}@${version}.`;
  }

  const changelog = readFileSync(changelogPath, "utf8");
  const heading = new RegExp(`^##\\s+${escapeRegExp(version)}\\s*$`, "m");
  const match = heading.exec(changelog);
  if (!match) {
    return `Published ${packageName}@${version}.`;
  }

  const start = match.index;
  const afterHeading = changelog.slice(start);
  const nextHeading = afterHeading.slice(match[0].length).search(/^##\s+/m);
  const section =
    nextHeading === -1
      ? afterHeading
      : afterHeading.slice(0, match[0].length + nextHeading);

  return `# ${packageName}\n\n${section.trim()}`;
}

export function packageArtifactBase(name, version) {
  return `${name.replace(/^@/, "").replace(/[\\/@]/g, "-")}-${version}`;
}

export function orderPackagesForPublish(packages) {
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

export function isPublishedToNpm(name, version) {
  const result = spawnSync(
    "npm",
    ["view", `${name}@${version}`, "version", "--registry", NPM_REGISTRY],
    {
      cwd: os.tmpdir(),
      encoding: "utf8",
    },
  );

  if (result.status !== 0) {
    return false;
  }

  return result.stdout.trim() === version;
}
