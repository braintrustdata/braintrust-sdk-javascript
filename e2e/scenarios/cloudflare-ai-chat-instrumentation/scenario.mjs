import { spawn } from "node:child_process";
import { stripVTControlCharacters } from "node:util";

const scenarioDir = new URL(".", import.meta.url).pathname;
const build = await runCommand([
  "exec",
  "vite",
  "build",
  "--config",
  "vite.config.ts",
]);
if (build.exitCode !== 0) {
  throw new Error(`Vite build failed (${build.exitCode}):\n${build.output}`);
}
const vite = spawn(
  "pnpm",
  [
    "exec",
    "vite",
    "preview",
    "--config",
    "vite.config.ts",
    "--host",
    "127.0.0.1",
    "--port",
    "0",
    "--strictPort",
  ],
  {
    cwd: scenarioDir,
    detached: process.platform !== "win32",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let output = build.output;
vite.stdout.on("data", (chunk) => (output += chunk.toString()));
vite.stderr.on("data", (chunk) => (output += chunk.toString()));

try {
  const baseUrl = await waitForServer();
  const success = await run(baseUrl, "success");
  if (!JSON.stringify(success).includes("CLOUDFLARE_AI_CHAT_TOOL_OK")) {
    throw new Error(
      `Successful chat result was incomplete: ${JSON.stringify(success)}`,
    );
  }

  const failure = await run(baseUrl, "error");
  if (!JSON.stringify(failure).includes("CLOUDFLARE_AI_CHAT_STREAM_ERROR")) {
    throw new Error(
      `Error chat result was incomplete: ${JSON.stringify(failure)}`,
    );
  }
} finally {
  await stopVite();
}

async function run(baseUrl, kind) {
  const response = await fetch(`${baseUrl}/run?kind=${kind}`, {
    signal: AbortSignal.timeout(60_000),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `Worker ${kind} request failed (${response.status}): ${body}\n${output}`,
    );
  }
  return JSON.parse(body);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (vite.exitCode !== null) {
      throw new Error(
        `Vite exited before startup (${vite.exitCode}):\n${output}`,
      );
    }
    const baseUrl = stripVTControlCharacters(output).match(
      /Local:\s+(http:\/\/127\.0\.0\.1:\d+)\//,
    )?.[1];
    if (baseUrl) {
      try {
        const response = await fetch(`${baseUrl}/health`, {
          signal: AbortSignal.timeout(1_000),
        });
        if (response.ok) {
          return baseUrl;
        }
      } catch {
        // Continue until workerd accepts requests.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for Vite:\n${output}`);
}

async function stopVite() {
  if (vite.exitCode !== null) {
    return;
  }
  try {
    if (process.platform !== "win32" && vite.pid) {
      process.kill(-vite.pid, "SIGTERM");
    } else {
      vite.kill("SIGTERM");
    }
  } catch {}
  await Promise.race([
    new Promise((resolve) => vite.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (vite.exitCode === null) {
    try {
      if (process.platform !== "win32" && vite.pid) {
        process.kill(-vite.pid, "SIGKILL");
      } else {
        vite.kill("SIGKILL");
      }
    } catch {}
  }
}

async function runCommand(args) {
  return await new Promise((resolve, reject) => {
    const child = spawn("pnpm", args, {
      cwd: scenarioDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let commandOutput = "";
    child.stdout.on("data", (chunk) => (commandOutput += chunk.toString()));
    child.stderr.on("data", (chunk) => (commandOutput += chunk.toString()));
    child.once("error", reject);
    child.once("exit", (code) =>
      resolve({ exitCode: code ?? 0, output: commandOutput }),
    );
  });
}
