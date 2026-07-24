import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const viteBin = path.join(
  path.dirname(require.resolve("vite/package.json")),
  "bin/vite.js",
);
const port = 9400 + Math.floor(Math.random() * 400);
const origin = `http://127.0.0.1:${port}`;
await writeFile(
  ".dev.vars",
  [
    `BRAINTRUST_APP_URL=${requiredEnv("BRAINTRUST_APP_URL")}`,
    `BRAINTRUST_API_URL=${requiredEnv("BRAINTRUST_API_URL")}`,
    `BRAINTRUST_API_KEY=${requiredEnv("BRAINTRUST_API_KEY")}`,
    `BRAINTRUST_E2E_PROJECT_NAME=${
      process.env.BRAINTRUST_E2E_PROJECT_NAME ||
      "cloudflare-think-instrumentation"
    }`,
    `BRAINTRUST_E2E_RUN_ID=${requiredEnv("BRAINTRUST_E2E_RUN_ID")}`,
    `OPENAI_API_KEY=${requiredEnv("OPENAI_API_KEY")}`,
    `OPENAI_BASE_URL=${requiredEnv("OPENAI_BASE_URL")}`,
  ].join("\n"),
);
const child = spawn(
  process.execPath,
  [
    viteBin,
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--strictPort",
    "--force",
  ],
  {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let output = "";
child.stdout.on("data", (chunk) => (output += chunk.toString()));
child.stderr.on("data", (chunk) => (output += chunk.toString()));

try {
  await waitUntilReady(`${origin}/health`);
  const url = new URL(origin);
  url.searchParams.set("agent", `agent-${process.env.BRAINTRUST_E2E_RUN_ID}`);
  url.searchParams.set("braintrustAppUrl", requiredEnv("BRAINTRUST_APP_URL"));
  url.searchParams.set("braintrustApiUrl", requiredEnv("BRAINTRUST_API_URL"));
  const response = await fetch(url);
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `Think worker returned ${response.status}: ${body}\n${output}`,
    );
  }
  const result = JSON.parse(body) as { status?: string };
  if (result.status !== "completed") {
    throw new Error(`Unexpected Think result: ${body}`);
  }
} finally {
  child.kill("SIGTERM");
  if (child.exitCode === null) {
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
  }
}

async function waitUntilReady(url: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Vite exited before becoming ready:\n${output}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // The dev server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for Vite:\n${output}`);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}
