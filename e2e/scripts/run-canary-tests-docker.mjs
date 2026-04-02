import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const DOCKER_COMMAND = process.platform === "win32" ? "docker.exe" : "docker";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const E2E_ROOT = path.resolve(SCRIPT_DIR, "..");
const REPO_ROOT = path.resolve(E2E_ROOT, "..");
const SCENARIOS_DIR = path.join(E2E_ROOT, "scenarios");
const DOCKERFILE_PATH = path.join(E2E_ROOT, "Dockerfile.canary");
const IMAGE_NAME = "braintrust-e2e-canary:local";
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"];

const ALLOWED_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "BRAINTRUST_API_KEY",
  "BRAINTRUST_E2E_PROJECT_NAME",
  "BRAINTRUST_APP_URL",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENROUTER_API_KEY",
  "MISTRAL_API_KEY",
];

function getAllowedEnv() {
  const env = {};
  for (const key of ALLOWED_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined && value !== "") {
      env[key] = value;
    }
  }

  if (process.env.CI) {
    env.CI = process.env.CI;
  }

  return env;
}

async function runCommand(command, args, cwd) {
  const { exitCode, signal } = await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
    });

    const cleanupSignalHandlers = [];
    for (const forwardedSignal of FORWARDED_SIGNALS) {
      const handler = () => {
        child.kill(forwardedSignal);
      };
      process.on(forwardedSignal, handler);
      cleanupSignalHandlers.push(() => process.off(forwardedSignal, handler));
    }

    const cleanup = () => {
      for (const cleanupHandler of cleanupSignalHandlers) {
        cleanupHandler();
      }
    };

    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("close", (code, childSignal) => {
      cleanup();
      resolve({ exitCode: code ?? 1, signal: childSignal });
    });
  });

  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

const passthroughArgs = process.argv.slice(2);
const containerEnv = getAllowedEnv();

await runCommand(
  DOCKER_COMMAND,
  ["build", "--file", DOCKERFILE_PATH, "--tag", IMAGE_NAME, "."],
  REPO_ROOT,
);

const dockerRunArgs = [
  "run",
  "--rm",
  "--cap-drop=ALL",
  // Prevent privilege escalation inside the container (e.g., via setuid/setgid binaries).
  "--security-opt=no-new-privileges",
  "--volume",
  `${SCENARIOS_DIR}:/workspace/e2e/scenarios:rw`,
  "--env",
  "HOME=/tmp",
];

if (
  typeof process.getuid === "function" &&
  typeof process.getgid === "function"
) {
  // Preserve host file ownership for snapshots written via the bind mount.
  dockerRunArgs.push("--user", `${process.getuid()}:${process.getgid()}`);
}

for (const [key, value] of Object.entries(containerEnv)) {
  dockerRunArgs.push("--env", `${key}=${value}`);
}

dockerRunArgs.push(
  IMAGE_NAME,
  "node",
  "e2e/scripts/run-canary-tests.mjs",
  ...passthroughArgs,
);

await runCommand(DOCKER_COMMAND, dockerRunArgs, REPO_ROOT);
