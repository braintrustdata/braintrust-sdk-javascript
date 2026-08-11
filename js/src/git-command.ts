import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import * as path from "node:path";

const GIT_EXECUTABLE_NAMES =
  process.platform === "win32" ? ["git.exe", "git"] : ["git"];
const GIT_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

let gitExecutablePromise: Promise<string | undefined> | undefined;

function executableSearchPath(): string | undefined {
  return Object.entries(process.env).find(
    ([name]) => name.toUpperCase() === "PATH",
  )?.[1];
}

export async function findGitExecutable(
  searchPath = executableSearchPath(),
): Promise<string | undefined> {
  if (!searchPath) {
    return undefined;
  }

  for (const rawSearchDir of searchPath.split(path.delimiter)) {
    const searchDir = rawSearchDir.trim().replace(/^"(.*)"$/, "$1");
    if (!path.isAbsolute(searchDir)) {
      continue;
    }

    for (const executableName of GIT_EXECUTABLE_NAMES) {
      const candidate = path.join(searchDir, executableName);
      try {
        await access(
          candidate,
          process.platform === "win32" ? constants.F_OK : constants.X_OK,
        );
        return candidate;
      } catch {
        // Keep searching PATH.
      }
    }
  }

  return undefined;
}

export async function resolveGitExecutable(): Promise<string | undefined> {
  gitExecutablePromise ??= findGitExecutable();
  return await gitExecutablePromise;
}

export async function runGitCommand(
  args: string[],
  options: { cwd?: string } = {},
): Promise<string> {
  const executable = await resolveGitExecutable();
  if (!executable) {
    throw new Error("Could not find a git executable on PATH");
  }

  return await new Promise<string>((resolve, reject) => {
    execFile(
      executable,
      args,
      {
        cwd: options.cwd,
        encoding: "utf8",
        maxBuffer: GIT_MAX_BUFFER_BYTES,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

export function resetGitExecutableCacheForTests(): void {
  gitExecutablePromise = undefined;
}
