import { spawn } from "node:child_process";
import net from "node:net";

const scenarioDir = new URL(".", import.meta.url).pathname;
const port = await reservePort();
const baseUrl = `http://127.0.0.1:${port}`;
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
    String(port),
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
  await waitForServer();
  const success = await run("success");
  if (!JSON.stringify(success).includes("CLOUDFLARE_AI_CHAT_TOOL_OK")) {
    throw new Error(
      `Successful chat result was incomplete: ${JSON.stringify(success)}`,
    );
  }

  const failure = await run("error");
  if (!JSON.stringify(failure).includes("CLOUDFLARE_AI_CHAT_STREAM_ERROR")) {
    throw new Error(
      `Error chat result was incomplete: ${JSON.stringify(failure)}`,
    );
  }
} finally {
  await stopVite();
}

async function run(kind) {
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
    try {
      const response = await fetch(`${baseUrl}/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        return;
      }
    } catch {}
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

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const selected = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return selected;
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
