import { spawn } from "node:child_process";
import { access, rm } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SCENARIO_NAME } from "./constants.mjs";

const flueCliPath = path.join(
  path.dirname(
    path.dirname(fileURLToPath(import.meta.resolve("@flue/cli/config"))),
  ),
  "bin",
  "flue.mjs",
);
const braintrustHookNodeOption = "--import=braintrust/hook.mjs";

function workflowPayload() {
  return {
    metadata: {
      scenario: SCENARIO_NAME,
      testRunId: process.env.BRAINTRUST_E2E_RUN_ID,
    },
    scenario: SCENARIO_NAME,
  };
}

export async function runNodeFlueInstrumentationScenario(options) {
  const env = scenarioEnv(options);
  const outputDir = path.join(process.cwd(), ".flue-build", options.outputName);
  await runFlueCli(
    [
      "build",
      "--target",
      "node",
      "--root",
      process.cwd(),
      "--output",
      outputDir,
    ],
    env,
  );

  const port = await getFreePort();
  const child = spawn(process.execPath, [path.join(outputDir, "server.mjs")], {
    cwd: process.cwd(),
    env: {
      ...env,
      PORT: String(port),
    },
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

  try {
    await waitForFlueServer(child, () => ({ stderr, stdout }));
    const workflowResponse = await fetch(
      `http://127.0.0.1:${port}/workflows/instrumentation?wait=result`,
      {
        body: JSON.stringify(workflowPayload()),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );
    if (!workflowResponse.ok) {
      throw new Error(
        `workflow request failed with ${workflowResponse.status}\n${await workflowResponse.text()}`,
      );
    }
    await workflowResponse.arrayBuffer();

    const flushResponse = await fetch(
      `http://127.0.0.1:${port}/__braintrust_flush`,
      { method: "POST" },
    );
    if (!flushResponse.ok) {
      throw new Error(
        `flush request failed with ${flushResponse.status}\n${await flushResponse.text()}`,
      );
    }
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
    );
  } finally {
    await stopChild(child);
  }
}

export async function runCliFlueInstrumentationScenario() {
  const flushFile = path.join(process.cwd(), ".flue-build", "cli-flushed");
  await rm(flushFile, { force: true });
  await runFlueCli(
    [
      "run",
      "instrumentation",
      "--target",
      "node",
      process.env.FLUE_E2E_INPUT_FLAG ?? "--payload",
      JSON.stringify(workflowPayload()),
      "--root",
      process.cwd(),
    ],
    {
      ...scenarioEnv({ autoHook: true, explicitObserve: false }),
      FLUE_E2E_FLUSH_FILE: flushFile,
    },
  );
  await waitForFile(flushFile);
}

export function runExplicitFlueInstrumentation() {
  return runNodeFlueInstrumentationScenario({
    autoHook: false,
    explicitObserve: true,
    outputName: "explicit",
  });
}

export function runAutoFlueInstrumentation() {
  return runNodeFlueInstrumentationScenario({
    autoHook: true,
    explicitObserve: false,
    outputName: "auto-hook",
  });
}

export function runCliFlueInstrumentation() {
  return runCliFlueInstrumentationScenario();
}

function scenarioEnv({ autoHook, explicitObserve }) {
  const env = {
    ...process.env,
    FLUE_E2E_EXPLICIT_OBSERVE: explicitObserve ? "1" : "0",
  };
  if (!autoHook) {
    return env;
  }
  return {
    ...env,
    NODE_OPTIONS: [env.NODE_OPTIONS, braintrustHookNodeOption]
      .filter(Boolean)
      .join(" "),
  };
}

async function runFlueCli(args, env) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [flueCliPath, ...args], {
      cwd: process.cwd(),
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
        resolve();
        return;
      }

      reject(
        new Error(
          `flue ${args.join(" ")} failed with exit code ${code ?? 0}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
        ),
      );
    });
  });
}

async function getFreePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (!address || typeof address === "string") {
    throw new Error("failed to allocate a local port for the Flue server");
  }
  return address.port;
}

async function waitForFlueServer(child, output) {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("timed out waiting for Flue server startup"));
    }, 30_000);
    const onData = () => {
      if (output().stdout.includes("Server listening")) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`Flue server exited before startup with code ${code}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", onExit);
    onData();
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, 5_000).unref();
  });
}

async function waitForFile(filePath) {
  const startedAt = Date.now();
  while (true) {
    try {
      await access(filePath);
      return;
    } catch {
      if (Date.now() - startedAt > 30_000) {
        throw new Error(
          `timed out waiting for Flue e2e flush marker: ${filePath}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

export function runMain(main) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
