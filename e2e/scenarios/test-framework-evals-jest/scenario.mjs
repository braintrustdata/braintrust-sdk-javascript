import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMain } from "../../helpers/provider-runtime.mjs";

const require = createRequire(import.meta.url);
const scenarioDir = path.dirname(fileURLToPath(import.meta.url));
const jestPackageName = process.env.JEST_PACKAGE_NAME ?? "jest-v29-latest";
const jestCliPath = path.join(
  path.dirname(require.resolve(`${jestPackageName}/package.json`)),
  "bin/jest.js",
);

async function runJest() {
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [jestCliPath, "--config", "jest.config.cjs", "--runInBand"],
      {
        cwd: scenarioDir,
        env: process.env,
        stdio: "inherit",
      },
    );

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Jest subprocess timed out after 60000ms"));
    }, 60_000);

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve(undefined);
        return;
      }

      reject(new Error(`Jest subprocess exited with code ${code ?? 0}`));
    });
  });
}

async function main() {
  await runJest();
}

runMain(main);
