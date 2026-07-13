#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseDotEnv } from "dotenv";

const DOCKER_COMMAND = process.platform === "win32" ? "docker.exe" : "docker";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const E2E_ROOT = path.resolve(SCRIPT_DIR, "..");
const REPO_ROOT = path.resolve(E2E_ROOT, "..");
const SCENARIOS_DIR = path.join(E2E_ROOT, "scenarios");
const DOCKERFILE_PATH = path.join(E2E_ROOT, "Dockerfile.e2e-bump");
const IMAGE_NAME = "braintrust-e2e-bump:local";
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"];

const ALLOWED_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_BASE_URL",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_BEDROCK_RUNTIME_BASE_URL",
  "AWS_DEFAULT_REGION",
  "AWS_REGION",
  "BEDROCK_RUNTIME_BASE_URL",
  "BRAINTRUST_ANTHROPIC_BEDROCK_MODEL",
  "BRAINTRUST_API_KEY",
  "BRAINTRUST_APP_PUBLIC_URL",
  "BRAINTRUST_APP_URL",
  "BRAINTRUST_BEDROCK_CONVERSE_MODEL",
  "BRAINTRUST_E2E_MODEL_BASE_URL",
  "BRAINTRUST_E2E_PROJECT_NAME",
  "CO_API_KEY",
  "COHERE_API_KEY",
  "COHERE_API_URL",
  "COHERE_BASE_URL",
  "CURSOR_API_KEY",
  "CURSOR_BACKEND_URL",
  "GEMINI_API_KEY",
  "GEMINI_BASE_URL",
  "GEMINI_NEXT_GEN_API_BASE_URL",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GOOGLE_API_KEY",
  "GOOGLE_GENERATIVE_AI_BASE_URL",
  "GOOGLE_GENAI_API_KEY",
  "GOOGLE_GENAI_BASE_URL",
  "GROQ_API_KEY",
  "GROQ_BASE_URL",
  "HF_ENDPOINT",
  "HF_INFERENCE_ENDPOINT",
  "HUGGINGFACE_API_KEY",
  "HUGGINGFACE_BASE_URL",
  "HUGGINGFACE_ROUTER_BASE_URL",
  "MISTRAL_AGENT_ID",
  "MISTRAL_API_KEY",
  "MISTRAL_API_URL",
  "MISTRAL_BASE_URL",
  "MISTRAL_CLASSIFIER_MODEL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_CODEX_E2E_MODEL",
  "OPENROUTER_API_KEY",
  "OPENROUTER_BASE_URL",
];

function loadRepoEnv() {
  const originalEnvKeys = new Set(Object.keys(process.env));
  for (const envFile of [".env", ".env.local"]) {
    const envPath = path.join(REPO_ROOT, envFile);
    if (existsSync(envPath)) {
      const parsed = parseDotEnv(readFileSync(envPath));
      for (const [key, value] of Object.entries(parsed)) {
        if (!originalEnvKeys.has(key)) {
          process.env[key] = value;
        }
      }
    }
  }
}

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

loadRepoEnv();

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
  dockerRunArgs.push("--user", `${process.getuid()}:${process.getgid()}`);
}

for (const key of Object.keys(containerEnv)) {
  dockerRunArgs.push("--env", key);
}

dockerRunArgs.push(
  IMAGE_NAME,
  "node",
  "e2e/scripts/bump-e2e-versions.mjs",
  ...passthroughArgs,
);

await runCommand(DOCKER_COMMAND, dockerRunArgs, REPO_ROOT);
