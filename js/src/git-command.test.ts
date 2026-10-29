import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import {
  findGitExecutable,
  resetGitExecutableCacheForTests,
  resolveGitExecutable,
  runGitCommand,
} from "./git-command";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(
    (
      _file: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string) => void,
    ) => callback(null, "git version 2.0.0\n"),
  ),
}));

let gitDir: string;
let gitExecutable: string;

beforeEach(async () => {
  gitDir = await mkdtemp(path.join(tmpdir(), "braintrust-git-command-"));
  gitExecutable = path.join(
    gitDir,
    process.platform === "win32" ? "git.exe" : "git",
  );
  await writeFile(gitExecutable, "", { mode: 0o755 });
  const pathKey = Object.keys(process.env).find(
    (name) => name.toUpperCase() === "PATH",
  );
  vi.stubEnv(pathKey ?? "PATH", gitDir);
});

afterEach(async () => {
  resetGitExecutableCacheForTests();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  await rm(gitDir, { recursive: true, force: true });
});

test("resolves git to an absolute executable path", async () => {
  const executable = await resolveGitExecutable();

  expect(executable).toBe(gitExecutable);
  expect(path.isAbsolute(executable!)).toBe(true);
});

test("runs git using the resolved executable without a shell", async () => {
  await expect(runGitCommand(["--version"], { cwd: gitDir })).resolves.toBe(
    "git version 2.0.0\n",
  );
  expect(execFile).toHaveBeenCalledWith(
    gitExecutable,
    ["--version"],
    { cwd: gitDir, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
    expect.any(Function),
  );
});

test("ignores relative PATH entries", async () => {
  await expect(findGitExecutable(".")).resolves.toBeUndefined();
});
