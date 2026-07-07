import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "fixtures", "vendor-hooks");
const iitmSrc = "../../src/auto-instrumentations/import-in-the-middle/";

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

  it("does not replay export-scan source for wrapped async loader modules", async () => {
    await runNode({
      args: [
        "--experimental-loader",
        path.join(fixturesDir, "iitm-reload-loader.mjs"),
        "--import",
        path.join(fixturesDir, "iitm-reload-setup.mjs"),
        path.join(fixturesDir, "iitm-reload-app.mjs"),
      ],
      cwd: fixturesDir,
    });
  });

  it("collects exports from type-stripped TypeScript formats", async () => {
    const stripTypeScriptTypes = (
      process as NodeJS.Process & {
        getBuiltinModule?: (name: "module") => {
          stripTypeScriptTypes?: unknown;
        };
      }
    ).getBuiltinModule?.("module").stripTypeScriptTypes;
    if (typeof stripTypeScriptTypes !== "function") {
      return;
    }

    const [{ getExports }, { driveSync }] = await Promise.all([
      import(`${iitmSrc}lib/get-exports.mts`),
      import(`${iitmSrc}lib/io.mts`),
    ]);

    const esmExports = driveSync(
      getExports("file:///virtual/typescript-hook.mts", {
        format: "module-typescript",
      }),
      {
        load: () => ({
          format: "module-typescript",
          source: `
            export type OnlyAType = { a: number };
            export interface AlsoAType { b: string }
            export const alpha: number = 1, beta: string = "two";
            export function gamma(n: number): number { return n + alpha; }
            export class Delta { value: number = 3; }
          `,
        }),
      },
    );
    expect([...esmExports].sort()).toEqual(["Delta", "alpha", "beta", "gamma"]);

    const cjsExports = driveSync(
      getExports("file:///virtual/typescript-hook.cts", {
        format: "commonjs-typescript",
      }),
      {
        load: () => ({
          format: "commonjs-typescript",
          source: `
            interface Shape { kind: string }
            const epsilon: number = 5;
            function zeta(s: Shape): string { return s.kind; }
            module.exports = { epsilon, zeta };
          `,
        }),
      },
    );
    expect([...cjsExports].sort()).toEqual([
      "default",
      "epsilon",
      "module.exports",
      "zeta",
    ]);
  });

  it("keeps ModuleBinder state isolated and resolves deferred exports", async () => {
    const { ModuleBinder } = await import(`${iitmSrc}lib/register.mts`);

    const first = new ModuleBinder();
    const second = new ModuleBinder();
    let firstValue: unknown;
    let secondValue: unknown;

    first.bind(
      "foo",
      { foo: 1 },
      (value: unknown) => {
        firstValue = value;
      },
      () => firstValue,
      false,
    );
    second.bind(
      "bar",
      { bar: 2 },
      (value: unknown) => {
        secondValue = value;
      },
      () => secondValue,
      false,
    );

    expect(firstValue).toBe(1);
    expect(secondValue).toBe(2);
    expect(Object.keys(first.set)).toEqual(["foo"]);
    expect(Object.keys(second.set)).toEqual(["bar"]);

    const deferred = new ModuleBinder();
    const source: { value?: number } = {};
    let value: unknown;
    deferred.bind(
      "value",
      source,
      (next: unknown) => {
        value = next;
      },
      () => value,
      false,
    );
    source.value = 7;
    deferred.flush();
    await Promise.resolve();
    expect(value).toBe(7);

    expect(first.set.foo(42)).toBe(true);
    first.flush();
    expect(firstValue).toBe(42);
  });

  it("only wraps explicitly hooked CommonJS requires", async () => {
    await runNode({
      args: [path.join(fixturesDir, "ritm-app.cjs")],
      cwd: fixturesDir,
    });
  });

  it("coexists with other CommonJS require wrappers", async () => {
    await runNode({
      args: [path.join(fixturesDir, "ritm-coexist-app.cjs")],
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
  const nodeArgs = ["--import", "tsx", ...args];
  const normalizedArgs =
    process.platform === "win32"
      ? nodeArgs.map((arg, index) => {
          if (
            index > 0 &&
            nodeArgs[index - 1] === "--import" &&
            path.isAbsolute(arg)
          ) {
            return pathToFileURL(path.resolve(arg)).href;
          }
          return arg;
        })
      : nodeArgs;

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
        resolve(undefined);
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
