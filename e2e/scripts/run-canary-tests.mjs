import { spawn } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const PNPM_COMMAND = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const E2E_ROOT = path.resolve(SCRIPT_DIR, "..");
const SCENARIOS_DIR = path.join(E2E_ROOT, "scenarios");

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function getCanaryTestFiles() {
  const entries = await readdir(SCENARIOS_DIR, { withFileTypes: true });
  const testFiles = new Set();

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const scenarioDir = path.join(SCENARIOS_DIR, entry.name);
    const manifestPath = path.join(scenarioDir, "package.json");
    if (!(await fileExists(manifestPath))) {
      continue;
    }

    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const canaryDependencies =
      manifest?.braintrustScenario?.canary?.dependencies;
    if (
      !canaryDependencies ||
      typeof canaryDependencies !== "object" ||
      Array.isArray(canaryDependencies) ||
      Object.keys(canaryDependencies).length === 0
    ) {
      continue;
    }

    const configuredTestFile = manifest?.braintrustScenario?.canary?.testFile;
    const testPath =
      typeof configuredTestFile === "string" && configuredTestFile.length > 0
        ? path.resolve(scenarioDir, configuredTestFile)
        : path.join(scenarioDir, "scenario.test.ts");
    if (!(await fileExists(testPath))) {
      throw new Error(
        `Canary scenario ${entry.name} is missing test file ${path.relative(
          E2E_ROOT,
          testPath,
        )}`,
      );
    }

    testFiles.add(path.relative(E2E_ROOT, testPath));
  }

  return [...testFiles].sort();
}

async function runVitest(testFiles) {
  const env = {
    ...process.env,
    BRAINTRUST_E2E_MODE: "canary",
  };

  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(PNPM_COMMAND, ["exec", "vitest", "run", ...testFiles], {
      cwd: E2E_ROOT,
      env,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });

  process.exit(exitCode);
}

const testFiles = await getCanaryTestFiles();
if (testFiles.length === 0) {
  throw new Error("No canary e2e scenarios are configured.");
}

await runVitest(testFiles);
