#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const PNPM_COMMAND = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const E2E_ROOT = path.resolve(SCRIPT_DIR, "..");
const SCENARIOS_DIR = path.join(E2E_ROOT, "scenarios");
const REPO_ROOT = path.resolve(E2E_ROOT, "..");
const SKIP_BUMP_ARG = "--skip-bump";
const SKIP_RECORD_ARG = "--skip-record";
const SKIP_REPLAY_ARG = "--skip-replay";
const INSTALL_SECRET_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "AWS_BEARER_TOKEN_BEDROCK",
  "BRAINTRUST_API_KEY",
  "CO_API_KEY",
  "COHERE_API_KEY",
  "CURSOR_API_KEY",
  "GEMINI_API_KEY",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GOOGLE_API_KEY",
  "GOOGLE_GENAI_API_KEY",
  "GROQ_API_KEY",
  "HUGGINGFACE_API_KEY",
  "MISTRAL_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
];

const rawArgs = process.argv.slice(2).filter((arg) => arg !== "--");
const skipBump = rawArgs.includes(SKIP_BUMP_ARG);
const skipRecord = rawArgs.includes(SKIP_RECORD_ARG);
const skipReplay = rawArgs.includes(SKIP_REPLAY_ARG);
const scenarioFilters = rawArgs.filter(
  (arg) =>
    arg !== SKIP_BUMP_ARG && arg !== SKIP_RECORD_ARG && arg !== SKIP_REPLAY_ARG,
);

for (const scenarioName of scenarioFilters) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(scenarioName)) {
    throw new Error(
      `Expected scenario names like "openai-instrumentation", got "${scenarioName}".`,
    );
  }
}

const selectedScenarios = await discoverBumpScenarios(scenarioFilters);
if (selectedScenarios.length === 0) {
  throw new Error("No e2e scenarios with braintrustScenario.bump were found.");
}

if (!skipBump) {
  await bumpScenarioDependencies(selectedScenarios);
}

const scenarioNames = selectedScenarios.map((scenario) => scenario.name);
if (!skipRecord) {
  await runCommand(process.execPath, [
    "scripts/run-record-tests.mjs",
    ...scenarioNames,
  ]);
  await runCommand(
    process.execPath,
    ["scripts/run-e2e-tests.mjs", "--update", ...scenarioNames],
    {
      env: replayVerificationEnv(),
    },
  );
}
if (!skipReplay) {
  await runCommand(
    process.execPath,
    ["scripts/run-e2e-tests.mjs", ...scenarioNames],
    {
      env: replayVerificationEnv(),
    },
  );
}

async function discoverBumpScenarios(filters) {
  const filterSet = new Set(filters);
  const entries = await readdir(SCENARIOS_DIR, { withFileTypes: true });
  const scenarios = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (filterSet.size > 0 && !filterSet.has(entry.name)) {
      continue;
    }

    const scenarioDir = path.join(SCENARIOS_DIR, entry.name);
    const manifestPath = path.join(scenarioDir, "package.json");
    if (!existsSync(manifestPath)) {
      continue;
    }

    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const dependencies = manifest.braintrustScenario?.bump?.dependencies;
    if (
      dependencies &&
      typeof dependencies === "object" &&
      !Array.isArray(dependencies) &&
      Object.keys(dependencies).length > 0
    ) {
      scenarios.push({
        dir: scenarioDir,
        manifest,
        manifestPath,
        name: entry.name,
      });
    }
  }

  if (filterSet.size > 0) {
    const foundNames = new Set(scenarios.map((scenario) => scenario.name));
    for (const filter of filterSet) {
      if (!foundNames.has(filter)) {
        throw new Error(
          `Scenario "${filter}" does not exist or has no braintrustScenario.bump dependencies.`,
        );
      }
    }
  }

  return scenarios.sort((left, right) => left.name.localeCompare(right.name));
}

async function bumpScenarioDependencies(scenarios) {
  const policy = await readPnpmPolicy();
  const metadataCache = new Map();

  for (const scenario of scenarios) {
    const dependencies = scenario.manifest.dependencies ?? {};
    const rules = scenario.manifest.braintrustScenario.bump.dependencies;
    const updates = [];

    for (const [dependencyName, rawRule] of Object.entries(rules)) {
      const rule = normalizeBumpRule(dependencyName, rawRule, scenario.name);
      let metadata = metadataCache.get(rule.package);
      if (!metadata) {
        metadata = await fetchPackageMetadata(rule.package);
        metadataCache.set(rule.package, metadata);
      }

      const version = selectLatestVersion({
        allowPrerelease: rule.allowPrerelease,
        metadata,
        packageName: rule.package,
        policy,
        range: rule.range,
      });
      const nextSpec = packageSpecifier(dependencyName, rule.package, version);
      if (dependencies[dependencyName] !== nextSpec) {
        updates.push({
          dependencyName,
          from: dependencies[dependencyName] ?? "<missing>",
          to: nextSpec,
        });
        dependencies[dependencyName] = nextSpec;
      }
    }

    if (updates.length === 0) {
      console.error(`[bump] ${scenario.name}: already up to date`);
      continue;
    }

    scenario.manifest.dependencies = dependencies;
    await writeFile(
      scenario.manifestPath,
      `${JSON.stringify(scenario.manifest, null, 2)}\n`,
    );
    for (const update of updates) {
      console.error(
        `[bump] ${scenario.name}: ${update.dependencyName} ${update.from} -> ${update.to}`,
      );
    }
    await runCommand(
      PNPM_COMMAND,
      [
        "install",
        "--dir",
        scenario.dir,
        "--ignore-workspace",
        "--lockfile-only",
        "--strict-peer-dependencies=false",
      ],
      { env: installEnv() },
    );
  }
}

function normalizeBumpRule(dependencyName, rawRule, scenarioName) {
  if (!dependencyName.endsWith("-latest")) {
    throw new Error(
      `${scenarioName} has a bump rule for ${dependencyName}, but bump rules may only target latest lane aliases ending in "-latest".`,
    );
  }

  if (!rawRule || typeof rawRule !== "object" || Array.isArray(rawRule)) {
    throw new Error(
      `${scenarioName} has an invalid bump rule for ${dependencyName}; expected an object.`,
    );
  }
  if (typeof rawRule.package !== "string" || rawRule.package.length === 0) {
    throw new Error(
      `${scenarioName} has an invalid bump rule for ${dependencyName}; expected a package name.`,
    );
  }
  if (typeof rawRule.range !== "string" || rawRule.range.length === 0) {
    throw new Error(
      `${scenarioName} has an invalid bump rule for ${dependencyName}; expected a range.`,
    );
  }

  return {
    allowPrerelease: rawRule.allowPrerelease === true,
    package: rawRule.package,
    range: rawRule.range,
  };
}

async function readPnpmPolicy() {
  const minimumReleaseAgeRaw = await pnpmConfig("minimumReleaseAge");
  const minimumReleaseAge = Number.parseInt(minimumReleaseAgeRaw, 10);
  const minimumReleaseAgeMinutes = Number.isFinite(minimumReleaseAge)
    ? minimumReleaseAge
    : 0;
  let minimumReleaseAgeExclude = [];
  try {
    minimumReleaseAgeExclude = JSON.parse(
      await pnpmConfig("minimumReleaseAgeExclude", "--json"),
    );
  } catch {
    minimumReleaseAgeExclude = [];
  }

  return {
    minimumReleaseAgeExclude: Array.isArray(minimumReleaseAgeExclude)
      ? minimumReleaseAgeExclude.filter((value) => typeof value === "string")
      : [],
    minimumReleaseAgeMinutes,
  };
}

async function pnpmConfig(key, ...args) {
  return await spawnCapture(PNPM_COMMAND, ["config", "get", key, ...args], {
    cwd: REPO_ROOT,
    env: process.env,
  });
}

async function fetchPackageMetadata(packageName) {
  const registry = (
    process.env.npm_config_registry || "https://registry.npmjs.org/"
  ).replace(/\/?$/, "/");
  const response = await fetch(`${registry}${encodeURIComponent(packageName)}`);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch npm metadata for ${packageName}: ${response.status} ${response.statusText}`,
    );
  }
  return await response.json();
}

function selectLatestVersion({
  allowPrerelease,
  metadata,
  packageName,
  policy,
  range,
}) {
  const now = Date.now();
  const minimumAgeMs = packageMatchesAnyPattern(
    packageName,
    policy.minimumReleaseAgeExclude,
  )
    ? 0
    : policy.minimumReleaseAgeMinutes * 60_000;
  const candidates = Object.keys(metadata.versions ?? {})
    .filter((version) => {
      const parsed = parseSemver(version);
      if (!parsed) {
        return false;
      }
      if (!allowPrerelease && parsed.prerelease.length > 0) {
        return false;
      }
      if (!satisfiesRange(parsed, range)) {
        return false;
      }
      if (minimumAgeMs > 0) {
        const publishedAt = metadata.time?.[version];
        if (!publishedAt || Date.parse(publishedAt) > now - minimumAgeMs) {
          return false;
        }
      }
      return true;
    })
    .sort(compareVersions)
    .reverse();

  if (candidates.length === 0) {
    throw new Error(
      `No ${packageName} version satisfies range "${range}" and pnpm minimumReleaseAge=${policy.minimumReleaseAgeMinutes} minutes.`,
    );
  }
  return candidates[0];
}

function packageMatchesAnyPattern(packageName, patterns) {
  return patterns.some((pattern) => {
    const escaped = pattern
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`).test(packageName);
  });
}

function packageSpecifier(dependencyName, packageName, version) {
  return dependencyName === packageName
    ? version
    : `npm:${packageName}@${version}`;
}

function installEnv() {
  const env = { ...process.env };
  for (const key of INSTALL_SECRET_ENV_VARS) {
    delete env[key];
  }
  return env;
}

function replayVerificationEnv() {
  const env = { ...process.env };
  // The record phase exercises live Braintrust forwarding when a real key is
  // present. Replay should only verify the committed cassettes and snapshots.
  delete env.BRAINTRUST_API_KEY;
  return env;
}

function parseSemver(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-.]+))?(?:\+.+)?$/.exec(
    version,
  );
  if (!match) {
    return null;
  }
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
    prerelease: match[4] ? match[4].split(".") : [],
    version,
  };
}

function compareVersions(left, right) {
  return compareParsedSemver(parseSemver(left), parseSemver(right));
}

function compareParsedSemver(left, right) {
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) {
      return left[key] - right[key];
    }
  }

  if (left.prerelease.length === 0 && right.prerelease.length === 0) {
    return 0;
  }
  if (left.prerelease.length === 0) {
    return 1;
  }
  if (right.prerelease.length === 0) {
    return -1;
  }

  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index++) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined) {
      return -1;
    }
    if (rightPart === undefined) {
      return 1;
    }
    if (leftPart === rightPart) {
      continue;
    }

    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : null;
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : null;
    if (leftNumber !== null && rightNumber !== null) {
      return leftNumber - rightNumber;
    }
    if (leftNumber !== null) {
      return -1;
    }
    if (rightNumber !== null) {
      return 1;
    }
    return leftPart.localeCompare(rightPart);
  }

  return 0;
}

function satisfiesRange(parsed, rawRange) {
  const range = rawRange.trim();
  if (range === "*" || range === "latest") {
    return true;
  }
  if (/^\d+$/.test(range)) {
    return parsed.major === Number.parseInt(range, 10);
  }
  if (/^\d+\.(?:x|\*)$/i.test(range)) {
    return parsed.major === Number.parseInt(range.split(".")[0], 10);
  }

  const exact = parseSemver(range);
  if (exact) {
    return compareParsedSemver(parsed, exact) === 0;
  }

  if (range.startsWith("^")) {
    const base = parseSemver(range.slice(1));
    if (!base || compareParsedSemver(parsed, base) < 0) {
      return false;
    }
    if (base.major > 0) {
      return parsed.major === base.major;
    }
    if (base.minor > 0) {
      return parsed.major === 0 && parsed.minor === base.minor;
    }
    return (
      parsed.major === 0 && parsed.minor === 0 && parsed.patch === base.patch
    );
  }

  if (range.startsWith("~")) {
    const base = parseSemver(range.slice(1));
    return (
      Boolean(base) &&
      compareParsedSemver(parsed, base) >= 0 &&
      parsed.major === base.major &&
      parsed.minor === base.minor
    );
  }

  if (/^(?:[<>=]=?\S+\s*)+$/.test(range)) {
    return range
      .split(/\s+/)
      .filter(Boolean)
      .every((comparator) => satisfiesComparator(parsed, comparator));
  }

  throw new Error(
    `Unsupported npm version range "${range}" in e2e bump metadata.`,
  );
}

function satisfiesComparator(parsed, comparator) {
  const match = /^(<=|>=|<|>|=)?(.+)$/.exec(comparator);
  if (!match) {
    return false;
  }
  const operator = match[1] ?? "=";
  let version = parseSemver(match[2]);
  if (!version) {
    const partial = /^(\d+)(?:\.(\d+))?$/.exec(match[2]);
    if (partial) {
      version = {
        major: Number.parseInt(partial[1], 10),
        minor: partial[2] ? Number.parseInt(partial[2], 10) : 0,
        patch: 0,
        prerelease: [],
        version: match[2],
      };
    }
  }
  if (!version) {
    throw new Error(`Unsupported npm version comparator "${comparator}".`);
  }
  const comparison = compareParsedSemver(parsed, version);
  switch (operator) {
    case "<":
      return comparison < 0;
    case "<=":
      return comparison <= 0;
    case ">":
      return comparison > 0;
    case ">=":
      return comparison >= 0;
    case "=":
      return comparison === 0;
    default:
      return false;
  }
}

async function spawnCapture(command, args, options) {
  const result = await spawnResult(command, args, options, "pipe");
  if (result.code !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.code}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

async function runCommand(command, args, options = {}) {
  const result = await spawnResult(
    command,
    args,
    { cwd: options.cwd ?? E2E_ROOT, env: options.env ?? process.env },
    "inherit",
  );
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return;
  }
  if (result.code !== 0) {
    process.exit(result.code ?? 1);
  }
}

async function spawnResult(command, args, options, stdio) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
  });

  if (stdio === "inherit") {
    return await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code, signal) =>
        resolve({ code: code ?? 1, signal, stderr: "", stdout: "" }),
      );
    });
  }

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  return await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) =>
      resolve({ code: code ?? 1, signal, stderr, stdout }),
    );
  });
}
