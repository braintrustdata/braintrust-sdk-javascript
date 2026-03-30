import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMain, runNodeSubprocess } from "../../helpers/scenario-runtime";

const scenarioDir = path.dirname(fileURLToPath(import.meta.url));
const nextBin = new URL("./node_modules/next/dist/bin/next", import.meta.url)
  .pathname;
const RESULT_MARKER = "NEXTJS_E2E_RESULT ";

type EndpointResult = {
  body: unknown;
  runtime: "edge" | "nodejs";
  status: number;
};

function withScenarioEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...env,
    NEXT_TELEMETRY_DISABLED: "1",
    NODE_ENV: "production",
  };
}

function httpErrorBody(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { rawBody: text };
  }
}

async function getAvailablePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not determine an available port"));
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
    server.on("error", reject);
  });
}

async function waitForServer(
  baseUrl: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(baseUrl, { method: "HEAD" });
      if (response.ok || response.status === 404) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return;
      }
    } catch {
      // Server is not ready yet.
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Next.js server did not become ready within ${timeoutMs}ms`);
}

async function callEndpoint(
  baseUrl: string,
  runtime: "edge" | "nodejs",
): Promise<EndpointResult> {
  const routeRuntime = runtime === "nodejs" ? "node" : runtime;
  const response = await fetch(`${baseUrl}/api/smoke-test/${routeRuntime}`);
  const text = await response.text();
  return {
    body: httpErrorBody(text),
    runtime,
    status: response.status,
  };
}

async function main() {
  const port = await getAvailablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = withScenarioEnv(process.env);

  await runNodeSubprocess({
    args: [nextBin, "build"],
    cwd: scenarioDir,
    env,
    timeoutMs: 180_000,
  });

  const server = spawn(
    process.execPath,
    [nextBin, "start", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: scenarioDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  server.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    await waitForServer(baseUrl);

    const responses = await Promise.all([
      callEndpoint(baseUrl, "edge"),
      callEndpoint(baseUrl, "nodejs"),
    ]);

    await new Promise((resolve) => setTimeout(resolve, 1_000));

    console.log(
      `${RESULT_MARKER}${JSON.stringify(
        responses.map((response) => ({
          ...response,
          body: response.body,
        })),
      )}`,
    );

    const failedResponse = responses.find((response) => {
      const body =
        response.body && typeof response.body === "object"
          ? (response.body as { success?: unknown })
          : undefined;
      return response.status !== 200 || body?.success !== true;
    });

    if (failedResponse) {
      throw new Error(
        `Endpoint ${failedResponse.runtime} failed with status ${failedResponse.status}\n${JSON.stringify(failedResponse.body, null, 2)}`,
      );
    }
  } finally {
    server.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    if (server.exitCode === null && !server.killed) {
      server.kill("SIGKILL");
    }

    if (stderr.trim()) {
      process.stderr.write(stderr);
    }
    if (stdout.trim()) {
      process.stdout.write(stdout);
    }
  }
}

runMain(main);
