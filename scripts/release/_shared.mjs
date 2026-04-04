import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(__dirname, "../..");
export const NPM_REGISTRY = "https://registry.npmjs.org/";
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
  {
    dir: "js/src/wrappers/claude-agent-sdk",
    name: "@braintrust/claude-agent-sdk-tests",
  },
  { dir: "e2e", name: "@braintrust/js-e2e-tests" },
];

export const PUBLISHABLE_PACKAGE_NAMES = PUBLISHABLE_PACKAGES.map(
  (pkg) => pkg.name,
);
export const PUBLISHABLE_PACKAGE_DIRS = new Set(
  PUBLISHABLE_PACKAGES.map((pkg) => pkg.dir),
);
export const PUBLISHABLE_PACKAGE_NAME_SET = new Set(PUBLISHABLE_PACKAGE_NAMES);
export const PUBLISHABLE_PACKAGE_MAP = new Map(
  PUBLISHABLE_PACKAGES.map((pkg) => [pkg.name, pkg]),
);

export function repoPath(...segments) {
  return path.join(REPO_ROOT, ...segments);
}

export function readJson(relativePath) {
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

export function getApprovedPackage(relativeDir) {
  return PUBLISHABLE_PACKAGES.find((pkg) => pkg.dir === relativeDir);
}

export function getApprovedPackageByName(name) {
  return PUBLISHABLE_PACKAGE_MAP.get(name);
}

export function toPosixPath(filePath) {
  return filePath.split(path.sep).join(path.posix.sep);
}

export function escapeRegExp(value) {
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
