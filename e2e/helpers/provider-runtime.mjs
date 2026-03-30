import { initLogger, startSpan, withCurrent } from "braintrust";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

export async function collectAsync(records) {
  const items = [];
  for await (const record of records) {
    items.push(record);
  }
  return items;
}

export function getTestRunId() {
  return process.env.BRAINTRUST_E2E_RUN_ID;
}

export function scopedName(base, testRunId = getTestRunId()) {
  if (process.env.BRAINTRUST_E2E_PROJECT_NAME) {
    return process.env.BRAINTRUST_E2E_PROJECT_NAME;
  }

  const suffix = testRunId.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  return `${base}-${suffix}`;
}

export async function runOperation(name, operation, callback) {
  const span = startSpan({
    name,
    event: {
      metadata: {
        operation,
        testRunId: getTestRunId(),
      },
    },
  });

  await withCurrent(span, callback);
  span.end();
}

export async function runTracedScenario(options) {
  const testRunId = getTestRunId();
  const logger = initLogger({
    projectName: scopedName(options.projectNameBase, testRunId),
  });

  await logger.traced(
    async () => {
      await options.callback({ testRunId });
    },
    {
      name: options.rootName,
      event: {
        metadata: {
          ...options.metadata,
          testRunId,
        },
      },
    },
  );

  const flushCount = options.flushCount ?? 1;
  const flushDelayMs = options.flushDelayMs ?? 0;

  for (let index = 0; index < flushCount; index++) {
    if (flushDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, flushDelayMs));
    }
    await logger.flush();
  }
}

export async function getInstalledPackageVersion(importMetaUrl, packageName) {
  let currentDir = path.dirname(
    require.resolve(packageName, {
      paths: [path.dirname(fileURLToPath(importMetaUrl))],
    }),
  );

  while (true) {
    const manifestPath = path.join(currentDir, "package.json");
    try {
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      if (manifest && typeof manifest.version === "string") {
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

export function runMain(main) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
