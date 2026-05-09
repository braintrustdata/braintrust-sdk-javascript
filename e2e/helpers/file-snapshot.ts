import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { isCanaryMode } from "./scenario-installer";
import { normalizeForSnapshot, type Json } from "./normalize";

function sortJsonKeys(value: Json): Json {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJsonKeys(entry as Json));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJsonKeys(value[key] as Json)]),
    ) as Json;
  }

  return value;
}

export function formatJsonFileSnapshot(value: Json): string {
  return `${JSON.stringify(sortJsonKeys(normalizeForSnapshot(value)), null, 2)}\n`;
}

export async function matchFileSnapshot(
  value: string,
  path: string,
): Promise<void> {
  // In canary mode always write the snapshot and pass — never fail on content
  // differences. The e2e-canary job catches live API failures; snapshot drift
  // is surfaced separately by the update-canary-snapshots PR workflow.
  if (isCanaryMode()) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value, "utf8");
    return;
  }
  await expect(value).toMatchFileSnapshot(path);
}

export function resolveFileSnapshotPath(
  testModuleUrl: string,
  filename: string,
): string {
  // Canary tests use the latest provider versions, which may produce different
  // span shapes. Keep their snapshots separate so pinned and canary baselines
  // can diverge independently.
  const subdir = isCanaryMode() ? "canary" : "";
  return join(
    dirname(fileURLToPath(testModuleUrl)),
    "__snapshots__",
    subdir,
    filename,
  );
}
