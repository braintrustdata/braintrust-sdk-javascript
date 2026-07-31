import { spawn } from "node:child_process";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMain, runNodeSubprocess } from "../../helpers/scenario-runtime";

const require = createRequire(import.meta.url);
const scenarioDir = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3999;
const bundler =
  process.env.NEXTJS_E2E_BUNDLER === "turbopack" ? "turbopack" : "webpack";
const nextVersion = require("next/package.json").version as string;
const nextMajorVersion = Number.parseInt(nextVersion.split(".")[0] ?? "", 10);

// Resolve next CLI relative to the scenario's own node_modules, since the
// scenario runs in a copy of this directory without .bin symlinks.
const nextBin = new URL("./node_modules/next/dist/bin/next", import.meta.url)
  .pathname;

function withScenarioEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const nextEnv: NodeJS.ProcessEnv = {
    ...env,
    NEXT_TELEMETRY_DISABLED: "1",
  };

  if (bundler === "turbopack") {
    nextEnv.TURBOPACK = "1";
  } else {
    delete nextEnv.TURBOPACK;
  }

  return nextEnv;
}

function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on("error", reject);
  });
}

async function waitForServer(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { status } = await httpGet(`http://localhost:${PORT}/api/test`);
      if (status === 200) return;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Next.js server did not become ready within ${timeoutMs}ms`);
}

// Top-level await is not supported in CJS output, so use an explicit async
// function and run it through the shared scenario wrapper.
async function main() {
  const env = withScenarioEnv(process.env);
  const buildArgs =
    bundler === "turbopack"
      ? [nextBin, "build", "--turbopack"]
      : Number.isFinite(nextMajorVersion) && nextMajorVersion >= 16
        ? [nextBin, "build", "--webpack"]
        : [nextBin, "build"];

  await runNodeSubprocess({
    args: buildArgs,
    cwd: scenarioDir,
    env,
    timeoutMs: 180_000,
  });

  // Start the Next.js server
  const server = spawn(
    process.execPath,
    [nextBin, "start", "--port", String(PORT)],
    {
      cwd: scenarioDir,
      stdio: "inherit",
      env,
    },
  );

  try {
    await waitForServer();

    const { body } = await httpGet(`http://localhost:${PORT}/api/test`);
    const data = JSON.parse(body) as { instrumented: boolean };

    if (!data.instrumented) {
      throw new Error(
        `OpenAI global hook did not fire; Next.js ${bundler} instrumentation is not working`,
      );
    }

    console.log(
      `OpenAI global hook fired at runtime; Next.js ${bundler} instrumentation is active`,
    );

    const edgeResponse = await httpGet(`http://localhost:${PORT}/api/edge`);
    const edgeData = JSON.parse(edgeResponse.body) as {
      openaiCreate: boolean;
      runtime: string;
    };

    if (edgeResponse.status !== 200 || edgeData.runtime !== "edge") {
      throw new Error(
        `Edge runtime route failed for Next.js ${bundler}: ${edgeResponse.status} ${edgeResponse.body}`,
      );
    }

    if (!edgeData.openaiCreate) {
      throw new Error(
        `OpenAI client was not usable in the Next.js ${bundler} edge runtime route`,
      );
    }
  } finally {
    server.kill();
  }
}

runMain(main);
