import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export type InstallScenarioDependenciesResult =
  | { status: "no-manifest" }
  | { status: "installed" };

export type ScenarioDependencyMode = "canary" | "locked";

export interface InstallScenarioDependenciesOptions {
  mode?: ScenarioDependencyMode;
  preferOffline?: boolean;
  scenarioDir: string;
}

const PNPM_COMMAND = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const TEMP_DIR_NAME = ".bt-tmp";
const CANARY_MODE_ENV = "BRAINTRUST_E2E_MODE";
const INSTALL_SECRET_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "BRAINTRUST_API_KEY",
  "GEMINI_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
] as const;

const cleanupDirs = new Set<string>();
let cleanupRegistered = false;

type CanaryDependencyRule = {
  packageName: string;
  query: string;
};

const canaryVersionCache = new Map<string, string>();
const HELPERS_DIR = path.dirname(fileURLToPath(import.meta.url));
const E2E_ROOT = path.resolve(HELPERS_DIR, "..");

interface ScenarioManifest {
  braintrustScenario?: {
    canary?: {
      dependencies?: Record<string, string>;
    };
  };
  dependencies?: Record<string, string>;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function spawnOrThrow(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }

      reject(
        new Error(
          `${command} ${args.join(" ")} failed with exit code ${code ?? 0}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
        ),
      );
    });
  });
}

function registerCleanupHandlers() {
  if (cleanupRegistered) {
    return;
  }

  cleanupRegistered = true;

  const cleanupAll = async () => {
    for (const dir of cleanupDirs) {
      try {
        await fs.rm(dir, { force: true, recursive: true });
      } catch {
        // Best-effort cleanup for ephemeral test directories.
      }
    }
    cleanupDirs.clear();
  };

  process.on("beforeExit", () => {
    void cleanupAll();
  });
  process.on("SIGINT", () => {
    void cleanupAll().finally(() => {
      process.exit(130);
    });
  });
  process.on("SIGTERM", () => {
    void cleanupAll().finally(() => {
      process.exit(143);
    });
  });
}

function installEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of INSTALL_SECRET_ENV_VARS) {
    delete env[key];
  }
  return env;
}

function scenarioNameForPath(scenarioDir: string): string {
  return path.basename(scenarioDir);
}

function packageSpecifier(
  dependencyName: string,
  packageName: string,
  version: string,
): string {
  return dependencyName === packageName
    ? version
    : `npm:${packageName}@${version}`;
}

async function resolveCanaryVersion(
  rule: CanaryDependencyRule,
): Promise<string> {
  const cacheKey = rule.query;
  const cached = canaryVersionCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const output = await spawnOrThrow(
    PNPM_COMMAND,
    ["view", rule.query, "version", "--json"],
    process.cwd(),
    installEnv(),
  );
  const parsed = JSON.parse(output) as string | string[];
  const version = Array.isArray(parsed) ? parsed.at(-1) : parsed;

  if (typeof version !== "string") {
    throw new Error(`Could not resolve canary version for ${rule.query}`);
  }

  canaryVersionCache.set(cacheKey, version);
  return version;
}

function parseCanaryDependencyRule(
  dependencyName: string,
  rawRule: string,
  scenarioDir: string,
): CanaryDependencyRule {
  if (typeof rawRule !== "string" || rawRule.length === 0) {
    throw new Error(
      `Invalid canary rule for ${dependencyName} in ${scenarioDir}/package.json`,
    );
  }

  if (rawRule === "latest") {
    return {
      packageName: dependencyName,
      query: dependencyName,
    };
  }

  const versionSeparator = rawRule.lastIndexOf("@");
  if (versionSeparator <= 0) {
    throw new Error(
      `Invalid canary rule for ${dependencyName} in ${scenarioDir}/package.json`,
    );
  }

  return {
    packageName: rawRule.slice(0, versionSeparator),
    query: rawRule,
  };
}

async function rewriteManifestForCanary(scenarioDir: string): Promise<void> {
  const manifestPath = path.join(scenarioDir, "package.json");
  const manifestRaw = await fs.readFile(manifestPath, "utf8");
  const manifest = JSON.parse(manifestRaw) as ScenarioManifest;
  const dependencies = manifest.dependencies ?? {};
  const rawRules = manifest.braintrustScenario?.canary?.dependencies ?? {};
  let updated = false;

  for (const [dependencyName, rawRule] of Object.entries(rawRules)) {
    if (!(dependencyName in dependencies)) {
      continue;
    }

    const rule = parseCanaryDependencyRule(
      dependencyName,
      rawRule,
      scenarioDir,
    );
    const version = await resolveCanaryVersion(rule);
    dependencies[dependencyName] = packageSpecifier(
      dependencyName,
      rule.packageName,
      version,
    );
    updated = true;
  }

  if (!updated) {
    return;
  }

  manifest.dependencies = dependencies;
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await spawnOrThrow(
    PNPM_COMMAND,
    [
      "install",
      "--dir",
      scenarioDir,
      "--ignore-workspace",
      "--lockfile-only",
      "--strict-peer-dependencies=false",
    ],
    scenarioDir,
    installEnv(),
  );
}

function findWorkspaceSpecs(
  manifest: Record<string, unknown>,
): Array<{ name: string; section: string; spec: string }> {
  const dependencySections = [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ] as const;

  return dependencySections.flatMap((section) => {
    const value = manifest[section];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return [];
    }

    return Object.entries(value).flatMap(([name, spec]) => {
      if (typeof spec === "string" && spec.startsWith("workspace:")) {
        return [{ name, section, spec }];
      }
      return [];
    });
  });
}

export async function installScenarioDependencies({
  mode = getScenarioDependencyMode(),
  preferOffline = true,
  scenarioDir,
}: InstallScenarioDependenciesOptions): Promise<InstallScenarioDependenciesResult> {
  const manifestPath = path.join(scenarioDir, "package.json");
  if (!(await fileExists(manifestPath))) {
    return { status: "no-manifest" };
  }
  const lockfilePath = path.join(scenarioDir, "pnpm-lock.yaml");
  if (!(await fileExists(lockfilePath))) {
    throw new Error(
      `Scenario package.json in ${scenarioDir} must also commit pnpm-lock.yaml. Generate it with: pnpm install --dir ${scenarioDir} --ignore-workspace --lockfile-only --strict-peer-dependencies=false`,
    );
  }

  const manifestRaw = await fs.readFile(manifestPath, "utf8");
  const manifest = JSON.parse(manifestRaw) as Record<string, unknown>;
  const workspaceSpecs = findWorkspaceSpecs(manifest);
  if (workspaceSpecs.length > 0) {
    const details = workspaceSpecs
      .map(({ name, section, spec }) => `${section}.${name} -> ${spec}`)
      .join(", ");
    throw new Error(
      `Scenario package.json in ${scenarioDir} cannot use workspace: dependencies (${details}). Keep workspace packages in e2e/package.json or use a non-workspace spec.`,
    );
  }

  if (mode === "canary") {
    await rewriteManifestForCanary(scenarioDir);
  }

  const installArgs = [
    "install",
    "--dir",
    scenarioDir,
    "--ignore-workspace",
    "--frozen-lockfile",
    "--strict-peer-dependencies=false",
  ];
  if (preferOffline) {
    installArgs.push("--prefer-offline");
  }

  await spawnOrThrow(PNPM_COMMAND, installArgs, scenarioDir, installEnv());
  return { status: "installed" };
}

export function getScenarioDependencyMode(): ScenarioDependencyMode {
  return process.env[CANARY_MODE_ENV] === "canary" ? "canary" : "locked";
}

export function isCanaryMode(): boolean {
  return getScenarioDependencyMode() === "canary";
}

export async function prepareScenarioDir(options: {
  mode?: ScenarioDependencyMode;
  preferOffline?: boolean;
  scenarioDir: string;
}): Promise<string> {
  const tempRoot = path.join(E2E_ROOT, TEMP_DIR_NAME);
  await fs.mkdir(tempRoot, { recursive: true });

  const runRoot = await fs.mkdtemp(path.join(tempRoot, "run-"));
  const preparedDir = path.join(
    runRoot,
    "scenarios",
    scenarioNameForPath(options.scenarioDir),
  );
  await fs.mkdir(preparedDir, { recursive: true });

  await fs.cp(path.join(E2E_ROOT, "helpers"), path.join(runRoot, "helpers"), {
    recursive: true,
  });

  const entries = await fs.readdir(options.scenarioDir);
  for (const entry of entries) {
    if (entry === "node_modules") {
      continue;
    }

    await fs.cp(
      path.join(options.scenarioDir, entry),
      path.join(preparedDir, entry),
      { recursive: true },
    );
  }

  cleanupDirs.add(runRoot);
  registerCleanupHandlers();

  await installScenarioDependencies({
    mode: options.mode,
    preferOffline: options.preferOffline,
    scenarioDir: preparedDir,
  });

  return preparedDir;
}

export async function readInstalledPackageVersion(
  scenarioDir: string,
  packageName: string,
): Promise<string> {
  const manifestPath = path.join(
    scenarioDir,
    "node_modules",
    ...packageName.split("/"),
    "package.json",
  );
  const manifestRaw = await fs.readFile(manifestPath, "utf8");
  const manifest = JSON.parse(manifestRaw) as { version?: string };

  if (typeof manifest.version !== "string") {
    throw new Error(
      `Could not read version for ${packageName} in ${scenarioDir}`,
    );
  }

  return manifest.version;
}
