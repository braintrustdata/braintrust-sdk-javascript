import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";

export interface SubprocessResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export async function collectAsync<T>(records: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const record of records) {
    items.push(record);
  }
  return items;
}

export function getTestRunId(): string {
  return process.env.BRAINTRUST_E2E_RUN_ID!;
}

export function scopedName(base: string, testRunId = getTestRunId()): string {
  if (process.env.BRAINTRUST_E2E_PROJECT_NAME) {
    return process.env.BRAINTRUST_E2E_PROJECT_NAME;
  }

  const suffix = testRunId.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  return `${base}-${suffix}`;
}

export function createTracerProvider(processors: unknown[]) {
  const testProvider = new BasicTracerProvider();

  if (
    typeof (testProvider as { addSpanProcessor?: unknown }).addSpanProcessor ===
    "function"
  ) {
    const provider = new BasicTracerProvider() as BasicTracerProvider & {
      addSpanProcessor: (processor: unknown) => void;
    };
    processors.forEach((processor) => provider.addSpanProcessor(processor));
    return provider;
  }

  return new BasicTracerProvider({
    spanProcessors: processors as never,
  });
}

export async function runNodeSubprocess(options: {
  args: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}): Promise<SubprocessResult> {
  const cwd = options.cwd ?? process.cwd();
  const timeoutMs = options.timeoutMs ?? 30_000;

  return await new Promise<SubprocessResult>((resolve, reject) => {
    const child = spawn(process.execPath, options.args, {
      cwd,
      env: {
        ...process.env,
        ...options.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(
        new Error(
          `Subprocess ${[process.execPath, ...options.args].join(" ")} timed out after ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);

      const result = {
        exitCode: code ?? 0,
        stderr,
        stdout,
      };

      if (result.exitCode !== 0) {
        reject(
          new Error(
            `Subprocess ${path.basename(process.execPath)} ${options.args.join(" ")} failed with exit code ${result.exitCode}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
          ),
        );
        return;
      }

      resolve(result);
    });
  });
}

export async function getInstalledPackageVersion(
  importMetaUrl: string,
  packageName: string,
): Promise<string> {
  const require = createRequire(importMetaUrl);
  let currentDir = path.dirname(require.resolve(packageName));

  while (true) {
    const manifestPath = path.join(currentDir, "package.json");
    try {
      const manifestRaw = await fs.readFile(manifestPath, "utf8");
      const manifest = JSON.parse(manifestRaw) as { version?: string };

      if (typeof manifest.version === "string") {
        return manifest.version;
      }
    } catch {
      // Keep walking upward until we find the package root.
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  throw new Error(`Could not resolve installed version for ${packageName}`);
}

export function runMain(main: () => Promise<void>): void {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
