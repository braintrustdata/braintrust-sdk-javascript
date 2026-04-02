import { spawn, execSync } from "node:child_process";
import {
  displayTestResults,
  hasFailures,
} from "../../../shared/dist/index.mjs";

const PORT = 8799;
const MAX_RETRIES = 20;
const RETRY_DELAY_MS = 250;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function killPort(port) {
  try {
    execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null || true`, {
      stdio: "ignore",
    });
  } catch {}
}

async function waitForServer() {
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const res = await fetch(`http://localhost:${PORT}/`);
      if (res.ok) return true;
    } catch {}
    await sleep(RETRY_DELAY_MS);
  }
  return false;
}

function displayResults(testResult) {
  if (testResult.results && testResult.results.length > 0) {
    displayTestResults({
      scenarioName: "Cloudflare Worker Node Compat Test Results",
      results: testResult.results,
    });
  } else {
    console.log(JSON.stringify(testResult, null, 2));
  }
}

async function main() {
  killPort(PORT);

  const wrangler = spawn(
    "pnpm",
    ["exec", "wrangler", "dev", "--port", String(PORT)],
    {
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
    },
  );

  let wranglerOutput = "";
  wrangler.stdout.on("data", (data) => (wranglerOutput += data));
  wrangler.stderr.on("data", (data) => (wranglerOutput += data));

  const killWrangler = () => {
    return new Promise((resolve) => {
      if (wrangler.exitCode !== null) {
        resolve();
        return;
      }
      wrangler.once("exit", resolve);
      wrangler.kill("SIGTERM");
      setTimeout(() => {
        if (wrangler.exitCode === null) {
          wrangler.kill("SIGKILL");
        }
      }, 1000);
    });
  };

  try {
    const serverStartedSuccessfully = await waitForServer();

    if (!serverStartedSuccessfully) {
      console.error("Server failed to start:\n", wranglerOutput);
      await killWrangler();
      process.exit(1);
    }

    const testResponse = await fetch(`http://localhost:${PORT}/test`);
    const testResult = await testResponse.json();

    displayResults(testResult);

    const exitCode = testResult.success ? 0 : 1;
    await killWrangler();
    process.exit(exitCode);
  } catch (error) {
    console.error("Error:", error.message, "\n", wranglerOutput);
    await killWrangler();
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
