import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export type InstallScenarioDependenciesResult =
  | { status: "no-manifest" }
  | { status: "installed" };

export interface InstallScenarioDependenciesOptions {
  preferOffline?: boolean;
  scenarioDir: string;
}

const PNPM_COMMAND = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const TEMP_DIR_NAME = ".bt-tmp";
const DEPENDENCY_CACHE_DIR_NAME = "scenario-deps";
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

const HELPERS_DIR = path.dirname(fileURLToPath(import.meta.url));
const E2E_ROOT = path.resolve(HELPERS_DIR, "..");

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

function scenarioNameForPath(scenarioDir: string): string {
  return path.basename(scenarioDir);
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
  inputs: ScenarioInstallInputs,
): string {
  const hash = createHash("sha256");
  hash.update(path.resolve(scenarioDir));
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

  return `${scenarioNameForPath(scenarioDir)}-${hash.digest("hex").slice(0, 16)}`;
}

async function installCachedScenarioDependencies({
  preferOffline = true,
  scenarioDir,
}: InstallScenarioDependenciesOptions): Promise<CachedScenarioDependenciesResult> {
  const inputs = await readScenarioInstallInputs(scenarioDir);
  if (!inputs) {
    return { status: "no-manifest" };
  }

  const cacheKey = scenarioDependencyCacheKey(scenarioDir, inputs);
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
    await installScenarioDependencies({
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
  preferOffline?: boolean;
  preparedDir: string;
  scenarioDir: string;
}): Promise<void> {
  const result = await installCachedScenarioDependencies({
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
  preferOffline = true,
  scenarioDir,
}: InstallScenarioDependenciesOptions): Promise<InstallScenarioDependenciesResult> {
  const inputs = await readScenarioInstallInputs(scenarioDir);
  if (!inputs) {
    return { status: "no-manifest" };
  }

  const installArgs = [
    "install",
    "--dir",
    scenarioDir,
    "--ignore-workspace",
    "--frozen-lockfile",
    "--ignore-scripts=false",
    "--strict-peer-dependencies=false",
  ];
  if (preferOffline) {
    installArgs.push("--prefer-offline");
  }

  await spawnOrThrow(PNPM_COMMAND, installArgs, scenarioDir, installEnv());
  return { status: "installed" };
}

export async function prepareScenarioDir(options: {
  linkDependencies?: boolean;
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
      preferOffline: options.preferOffline,
      scenarioDir: preparedDir,
    });
  } else {
    await linkCachedScenarioDependencies({
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
