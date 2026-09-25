import { EventEmitter } from "node:events";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const DEEPSEEK_KEY = "dummy-deepseek-key-for-bump-test";
const OPENAI_KEY = "dummy-openai-key-for-bump-test";
const SCENARIO = "openai-compatible-reasoning-instrumentation";
const E2E_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCENARIO_DIR = path.join(E2E_ROOT, "scenarios", SCENARIO);
const MANIFEST_PATH = path.join(SCENARIO_DIR, "package.json");
const originalEnv = process.env;
const originalArgv = process.argv;

interface Command {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

let commands: Command[];
let logs: ReturnType<typeof vi.spyOn>[];

beforeEach(() => {
  vi.resetModules();
  commands = [];
  process.env = {
    DEEPSEEK_API_KEY: DEEPSEEK_KEY,
    OPENAI_API_KEY: OPENAI_KEY,
    OPENAI_BASE_URL: "https://openai.example.invalid/v1",
    CI: "true",
    HARMLESS_TEST_SETTING: "keep-me",
  };
  logs = (["error", "log", "warn", "info", "debug"] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => {}),
  );
  vi.doMock("node:child_process", () => ({
    spawn: (
      command: string,
      args: string[],
      options: { env?: NodeJS.ProcessEnv },
    ) => {
      commands.push({
        command,
        args,
        env: { ...(options.env ?? process.env) },
      });
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn(),
      });
      queueMicrotask(() => {
        if (args[0] === "config") {
          child.stdout.emit(
            "data",
            args[2] === "minimumReleaseAge" ? "0" : "[]",
          );
        }
        child.emit("close", 0, null);
      });
      return child;
    },
  }));
});

afterEach(() => {
  process.env = originalEnv;
  process.argv = originalArgv;
  vi.doUnmock("node:child_process");
  vi.doUnmock("node:fs");
  vi.doUnmock("node:fs/promises");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function expectNoCredentialsInOutput() {
  const output = JSON.stringify({
    commands: commands.map(({ command, args }) => ({ command, args })),
    logs: logs.flatMap((log) => log.mock.calls),
  });
  expect(output).not.toContain(DEEPSEEK_KEY);
  expect(output).not.toContain(OPENAI_KEY);
}

it("forwards recording credentials to Docker by variable name without exposing their values", async () => {
  // Never load the developer's .env files or invoke a real Docker process.
  vi.doMock("node:fs", () => ({ existsSync: () => false }));
  process.argv = [process.execPath, "run-e2e-bump-docker.mjs", SCENARIO];

  await import("../scripts/run-e2e-bump-docker.mjs");

  expect(commands.map(({ args }) => args[0])).toEqual(["build", "run"]);
  const run = commands[1];
  const forwarded = run.args.flatMap((arg, index) =>
    arg === "--env" ? [run.args[index + 1]] : [],
  );
  expect(forwarded).toEqual(
    expect.arrayContaining([
      "OPENAI_API_KEY",
      "OPENAI_BASE_URL",
      "CI",
      "HOME=/tmp",
    ]),
  );
  expect(forwarded).not.toContain("HARMLESS_TEST_SETTING");
  expect(run.env.OPENAI_API_KEY).toBe(OPENAI_KEY);
  expect(run.env.DEEPSEEK_API_KEY).toBe(DEEPSEEK_KEY);
  expect(run.args.slice(-3)).toEqual([
    "node",
    "e2e/scripts/bump-e2e-versions.mjs",
    SCENARIO,
  ]);
  expectNoCredentialsInOutput();
  expect(forwarded).toContain("DEEPSEEK_API_KEY");
});

it("removes provider credentials from the actual dependency-install subprocess environment", async () => {
  const manifest = {
    dependencies: { "openai-latest": "npm:openai@6.0.0" },
    braintrustScenario: {
      bump: {
        dependencies: { "openai-latest": { package: "openai", range: "6" } },
      },
    },
  };
  const writeFile = vi.fn().mockResolvedValue(undefined);
  vi.doMock("node:fs", () => ({
    existsSync: (file: string) => file === MANIFEST_PATH,
  }));
  vi.doMock("node:fs/promises", () => ({
    readdir: async () => [{ name: SCENARIO, isDirectory: () => true }],
    readFile: async (file: string) => {
      expect(file).toBe(MANIFEST_PATH);
      return JSON.stringify(manifest);
    },
    writeFile,
  }));
  const fetchMetadata = vi.fn(async (url: string) => {
    expect(url).toBe("https://registry.npmjs.org/openai");
    return { ok: true, json: async () => ({ versions: { "6.0.1": {} } }) };
  });
  vi.stubGlobal("fetch", fetchMetadata);
  process.argv = [
    process.execPath,
    "bump-e2e-versions.mjs",
    "--skip-record",
    "--skip-replay",
    SCENARIO,
  ];

  await import("../scripts/bump-e2e-versions.mjs");

  expect(fetchMetadata).toHaveBeenCalledOnce();
  expect(writeFile).toHaveBeenCalledOnce();
  expect(JSON.parse(writeFile.mock.calls[0][1]).dependencies).toEqual({
    "openai-latest": "npm:openai@6.0.1",
  });
  expect(commands.map(({ args }) => args[0])).toEqual([
    "config",
    "config",
    "install",
  ]);
  const install = commands[2];
  expect(install.args).toEqual([
    "install",
    "--dir",
    SCENARIO_DIR,
    "--ignore-workspace",
    "--lockfile-only",
    "--strict-peer-dependencies=false",
  ]);
  expect(install.env.OPENAI_API_KEY).toBeUndefined();
  expect(install.env.OPENAI_BASE_URL).toBe(process.env.OPENAI_BASE_URL);
  expect(install.env.CI).toBe("true");
  expect(install.env.HARMLESS_TEST_SETTING).toBe("keep-me");
  expect(process.env.DEEPSEEK_API_KEY).toBe(DEEPSEEK_KEY);
  expect(process.env.OPENAI_API_KEY).toBe(OPENAI_KEY);
  expectNoCredentialsInOutput();
  expect(install.env.DEEPSEEK_API_KEY).toBeUndefined();
});
