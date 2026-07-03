import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "fixtures", "vendor-hooks");

describe("vendored import-in-the-middle and require-in-the-middle", () => {
  it("only wraps explicitly hooked ESM imports through the async loader", async () => {
    await runNode({
      args: [
        "--import",
        path.join(fixturesDir, "iitm-async-setup.mjs"),
        path.join(fixturesDir, "iitm-async-app.mjs"),
      ],
      cwd: fixturesDir,
    });
  });

  it("only wraps explicitly hooked ESM imports through sync registerHooks", async () => {
    await runNode({
      args: [path.join(fixturesDir, "iitm-sync-app.mjs")],
      cwd: fixturesDir,
    });
  });

  it("only wraps explicitly hooked CommonJS requires", async () => {
    await runNode({
      args: [path.join(fixturesDir, "ritm-app.cjs")],
      cwd: fixturesDir,
    });
  });
});

function runNode({
  args,
  cwd,
}: {
  args: string[];
  cwd: string;
}): Promise<void> {
  const normalizedArgs =
    process.platform === "win32"
      ? args.map((arg, index) => {
          if (index > 0 && args[index - 1] === "--import") {
            return pathToFileURL(path.resolve(arg)).href;
          }
          return arg;
        })
      : args;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, normalizedArgs, {
      cwd,
      env: { ...process.env, NODE_OPTIONS: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `Node exited with code ${code ?? "null"}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
          ),
        );
      }
    });
  }).then(() => {
    expect(true).toBe(true);
  });
}
