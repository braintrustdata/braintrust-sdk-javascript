import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import {
  getTestRunId,
  runMain,
  scopedName,
} from "../../helpers/scenario-runtime";

async function main() {
  const port = await getFreePort();
  const viteBin = path.join(
    process.cwd(),
    "node_modules",
    ".bin",
    process.platform === "win32" ? "vite.cmd" : "vite",
  );
  await writeWorkerDevVars();
  await buildWorker(viteBin);
  const server = spawn(
    viteBin,
    ["preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const output = captureOutput(server);

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForServer(baseUrl, server, output);
    const testRunId = getTestRunId();
    const projectName = scopedName(
      "e2e-cloudflare-agents-instrumentation",
      testRunId,
    );
    const response = await fetch(`${baseUrl}/run`, {
      body: JSON.stringify({ projectName, testRunId }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    if (!response.ok) {
      throw new Error(
        `Cloudflare Agents worker failed with ${response.status}: ${await response.text()}\n${output()}`,
      );
    }

    const result = (await response.json()) as {
      concurrent?: Array<{ status?: string }>;
      detached?: { status?: string };
      failure?: { error?: string; status?: string };
      success?: { status?: string };
    };
    if (
      result.success?.status !== "completed" ||
      result.failure?.status !== "error" ||
      result.failure.error !== "deterministic child failure" ||
      result.concurrent?.some((entry) => entry.status !== "completed") ||
      result.concurrent?.length !== 2 ||
      result.detached?.status !== "running"
    ) {
      throw new Error(`Unexpected scenario result: ${JSON.stringify(result)}`);
    }
  } finally {
    await stopServer(server);
  }
}

async function writeWorkerDevVars(): Promise<void> {
  const names = [
    "BRAINTRUST_API_KEY",
    "BRAINTRUST_API_URL",
    "BRAINTRUST_APP_PUBLIC_URL",
    "BRAINTRUST_APP_URL",
    "BRAINTRUST_E2E_RUN_ID",
    "BRAINTRUST_ORG_NAME",
    "BRAINTRUST_PROXY_URL",
  ];
  const contents = names
    .map((name) => `${name}=${JSON.stringify(process.env[name] ?? "")}`)
    .join("\n");
  await writeFile(path.join(process.cwd(), ".dev.vars"), `${contents}\n`);
}

async function buildWorker(viteBin: string): Promise<void> {
  const build = spawn(viteBin, ["build"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = captureOutput(build);
  const [exitCode] = (await once(build, "close")) as [number | null];
  if (exitCode !== 0) {
    throw new Error(`Vite build failed with code ${exitCode}\n${output()}`);
  }
}

async function getFreePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (!address || typeof address === "string") {
    throw new Error("Could not allocate a Vite preview-server port");
  }
  return address.port;
}

function captureOutput(child: ChildProcessWithoutNullStreams): () => string {
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  return () => `STDOUT:\n${stdout}\nSTDERR:\n${stderr}`;
}

async function waitForServer(
  baseUrl: string,
  server: ChildProcessWithoutNullStreams,
  output: () => string,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 60_000) {
    if (server.exitCode !== null) {
      throw new Error(
        `Vite exited early with code ${server.exitCode}\n${output()}`,
      );
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // Continue until workerd accepts requests.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for Vite/workerd\n${output()}`);
}

async function stopServer(server: ChildProcessWithoutNullStreams) {
  if (server.exitCode !== null) {
    return;
  }
  server.kill("SIGTERM");
  const timeout = setTimeout(() => server.kill("SIGKILL"), 5_000);
  try {
    await once(server, "close");
  } finally {
    clearTimeout(timeout);
  }
}

runMain(main);
