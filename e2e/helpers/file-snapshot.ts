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

/**
 * In canary mode (latest packages + live API) snapshots are not consulted —
 * canary verifies behaviour, not exact output shape.
 */
export async function matchFileSnapshot(
  value: string,
  path: string,
): Promise<void> {
  if (isCanaryMode()) return;
  await expect(value).toMatchFileSnapshot(path);
}

export function resolveFileSnapshotPath(
  testModuleUrl: string,
  filename: string,
): string {
  return join(dirname(fileURLToPath(testModuleUrl)), "__snapshots__", filename);
}
