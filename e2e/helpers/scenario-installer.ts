import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
const DEPENDENCY_CACHE_DIR_NAME = "scenario-deps";
const CANARY_MODE_ENV = "BRAINTRUST_E2E_MODE";
const SCENARIO_PNPM_WORKSPACE_CONFIG = `strictDepBuilds: true
allowBuilds:
  "@google/genai": false
  "@openrouter/sdk": false
  esbuild: false
  protobufjs: false
`;
const INSTALL_SECRET_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "BRAINTRUST_API_KEY",
  "CO_API_KEY",
  "COHERE_API_KEY",
  "CURSOR_API_KEY",
  "GEMINI_API_KEY",
  "GITHUB_TOKEN",
  "GOOGLE_API_KEY",
  "GOOGLE_GENAI_API_KEY",
  "GH_TOKEN",
  "GROQ_API_KEY",
  "HUGGINGFACE_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "MISTRAL_API_KEY",
] as const;

const cleanupDirs = new Set<string>();
let cleanupRegistered = false;
const dependencyCacheInstalls = new Map<
  string,
  Promise<CachedScenarioDependenciesResult>
>();
// Canary mode can resolve "latest"; keep that cache scoped to this test process.
const processCacheId = `${process.pid}-${Date.now()}`;

type CanaryDependencyRule = {
  packageName: string;
  version: string;
};

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

type ScenarioInstallInputs = {
  lockfileRaw: string;
  manifestRaw: string;
};

type CachedScenarioDependenciesResult =
  | { status: "no-manifest" }
  | { nodeModulesDir: string; status: "installed" };

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

function isTempScenarioDir(scenarioDir: string): boolean {
  const relativeToTemp = path.relative(
    path.join(E2E_ROOT, TEMP_DIR_NAME),
    path.resolve(scenarioDir),
  );
  return !relativeToTemp.startsWith("..") && !path.isAbsolute(relativeToTemp);
}

async function writeScenarioPnpmWorkspaceConfig(
  scenarioDir: string,
): Promise<void> {
  if (!isTempScenarioDir(scenarioDir)) {
    return;
  }

  await fs.writeFile(
    path.join(scenarioDir, "pnpm-workspace.yaml"),
    SCENARIO_PNPM_WORKSPACE_CONFIG,
  );
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
      version: "latest",
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
    version: rawRule.slice(versionSeparator + 1),
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
    dependencies[dependencyName] = packageSpecifier(
      dependencyName,
      rule.packageName,
      rule.version,
    );
    updated = true;
  }

  if (!updated) {
    return;
  }

  manifest.dependencies = dependencies;
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeScenarioPnpmWorkspaceConfig(scenarioDir);

  const installArgs = [
    "install",
    "--lockfile-only",
    "--strict-peer-dependencies=false",
  ];
  if (!isTempScenarioDir(scenarioDir)) {
    installArgs.push("--dir", scenarioDir, "--ignore-workspace");
  }

  await spawnOrThrow(PNPM_COMMAND, installArgs, scenarioDir, installEnv());
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

async function readScenarioInstallInputs(
  scenarioDir: string,
): Promise<ScenarioInstallInputs | null> {
  const manifestPath = path.join(scenarioDir, "package.json");
  if (!(await fileExists(manifestPath))) {
    return null;
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

  return {
    lockfileRaw: await fs.readFile(lockfilePath, "utf8"),
    manifestRaw,
  };
}

function scenarioDependencyCacheKey(
  scenarioDir: string,
  mode: ScenarioDependencyMode,
  inputs: ScenarioInstallInputs,
): string {
  const hash = createHash("sha256");
  hash.update(path.resolve(scenarioDir));
  hash.update("\0");
  hash.update(mode === "canary" ? `${mode}:${processCacheId}` : mode);
  hash.update("\0");
  hash.update(process.platform);
  hash.update("\0");
  hash.update(process.arch);
  hash.update("\0");
  hash.update(process.versions.modules);
  hash.update("\0");
  hash.update(inputs.manifestRaw);
  hash.update("\0");
  hash.update(inputs.lockfileRaw);

  return `${scenarioNameForPath(scenarioDir)}-${mode}-${hash.digest("hex").slice(0, 16)}`;
}

async function installCachedScenarioDependencies({
  mode = getScenarioDependencyMode(),
  preferOffline = true,
  scenarioDir,
}: InstallScenarioDependenciesOptions): Promise<CachedScenarioDependenciesResult> {
  const inputs = await readScenarioInstallInputs(scenarioDir);
  if (!inputs) {
    return { status: "no-manifest" };
  }

  const cacheKey = scenarioDependencyCacheKey(scenarioDir, mode, inputs);
  const cachedInstall = dependencyCacheInstalls.get(cacheKey);
  if (cachedInstall) {
    return await cachedInstall;
  }

  const installPromise = (async () => {
    const dependencyCacheRoot = path.join(
      E2E_ROOT,
      TEMP_DIR_NAME,
      DEPENDENCY_CACHE_DIR_NAME,
    );
    const cacheDir = path.join(dependencyCacheRoot, cacheKey);
    const nodeModulesDir = path.join(cacheDir, "node_modules");
    if (await fileExists(nodeModulesDir)) {
      return { nodeModulesDir, status: "installed" as const };
    }

    await fs.mkdir(dependencyCacheRoot, { recursive: true });
    const stagingDir = await fs.mkdtemp(
      path.join(dependencyCacheRoot, `${cacheKey}-`),
    );
    cleanupDirs.add(stagingDir);
    registerCleanupHandlers();

    await fs.writeFile(
      path.join(stagingDir, "package.json"),
      inputs.manifestRaw,
    );
    await fs.writeFile(
      path.join(stagingDir, "pnpm-lock.yaml"),
      inputs.lockfileRaw,
    );
    await writeScenarioPnpmWorkspaceConfig(stagingDir);
    await installScenarioDependencies({
      mode,
      preferOffline,
      scenarioDir: stagingDir,
    });

    try {
      await fs.rename(stagingDir, cacheDir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY") {
        throw err;
      }
      await fs.rm(stagingDir, { force: true, recursive: true });
      if (!(await fileExists(nodeModulesDir))) {
        throw err;
      }
    }

    if (mode === "canary") {
      cleanupDirs.add(cacheDir);
      registerCleanupHandlers();
    }

    return { nodeModulesDir, status: "installed" as const };
  })();

  dependencyCacheInstalls.set(cacheKey, installPromise);
  try {
    return await installPromise;
  } catch (err) {
    dependencyCacheInstalls.delete(cacheKey);
    throw err;
  }
}

async function linkCachedScenarioDependencies(options: {
  mode?: ScenarioDependencyMode;
  preferOffline?: boolean;
  preparedDir: string;
  scenarioDir: string;
}): Promise<void> {
  const result = await installCachedScenarioDependencies({
    mode: options.mode,
    preferOffline: options.preferOffline,
    scenarioDir: options.scenarioDir,
  });
  if (result.status === "no-manifest") {
    return;
  }

  const nodeModulesPath = path.join(options.preparedDir, "node_modules");
  await fs.rm(nodeModulesPath, { force: true, recursive: true });
  await fs.mkdir(nodeModulesPath, { recursive: true });

  const entries = await fs.readdir(result.nodeModulesDir, {
    withFileTypes: true,
  });
  await Promise.all(
    entries.map(async (entry) => {
      const sourcePath = path.join(result.nodeModulesDir, entry.name);
      const sourceStat = await fs.stat(sourcePath);
      await fs.symlink(
        sourcePath,
        path.join(nodeModulesPath, entry.name),
        sourceStat.isDirectory()
          ? process.platform === "win32"
            ? "junction"
            : "dir"
          : "file",
      );
    }),
  );
}

export async function installScenarioDependencies({
  mode = getScenarioDependencyMode(),
  preferOffline = true,
  scenarioDir,
}: InstallScenarioDependenciesOptions): Promise<InstallScenarioDependenciesResult> {
  const inputs = await readScenarioInstallInputs(scenarioDir);
  if (!inputs) {
    return { status: "no-manifest" };
  }

  if (mode === "canary") {
    await rewriteManifestForCanary(scenarioDir);
  }
  await writeScenarioPnpmWorkspaceConfig(scenarioDir);

  const installArgs = [
    "install",
    "--frozen-lockfile",
    "--ignore-scripts=false",
    "--strict-peer-dependencies=false",
  ];
  if (!isTempScenarioDir(scenarioDir)) {
    installArgs.push("--dir", scenarioDir, "--ignore-workspace");
  }
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
  linkDependencies?: boolean;
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

  if (options.linkDependencies === false) {
    await installScenarioDependencies({
      mode: options.mode,
      preferOffline: options.preferOffline,
      scenarioDir: preparedDir,
    });
  } else {
    await linkCachedScenarioDependencies({
      mode: options.mode,
      preparedDir,
      preferOffline: options.preferOffline,
      scenarioDir: options.scenarioDir,
    });
  }

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
