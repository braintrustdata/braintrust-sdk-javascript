import * as path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  findGitExecutable,
  resetGitExecutableCacheForTests,
  resolveGitExecutable,
  runGitCommand,
} from "./git-command";

afterEach(() => {
  resetGitExecutableCacheForTests();
});

test("resolves git to an absolute executable path", async () => {
  const executable = await resolveGitExecutable();

  expect(executable).toBeDefined();
  expect(path.isAbsolute(executable!)).toBe(true);
  await expect(runGitCommand(["--version"])).resolves.toMatch(/^git version /);
});

test("ignores relative PATH entries", async () => {
  await expect(findGitExecutable(".")).resolves.toBeUndefined();
});
