import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("links published runs while preserving legacy records and excluding local-only runs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "braintrust-e2e-links-"));
  const configPath = path.join(dir, "config.json");
  try {
    await writeFile(
      configPath,
      JSON.stringify([
        {
          scenarioDirName: "scenario",
          label: "Scenario",
          metadataScenario: "scenario",
        },
      ]),
    );
    await writeFile(
      path.join(dir, "runs.ndjson"),
      [
        { testRunId: "e2e-published", forwardToProduction: true },
        { testRunId: "e2e-local-only", forwardToProduction: false },
        { testRunId: "e2e-legacy" },
      ]
        .map((record) =>
          JSON.stringify({ scenarioDirName: "scenario", ...record }),
        )
        .join("\n"),
    );
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        fileURLToPath(
          new URL("../scripts/build-pr-e2e-links-comment.mjs", import.meta.url),
        ),
        "--config",
        configPath,
      ],
      {
        env: {
          ...process.env,
          BRAINTRUST_API_KEY: "",
          BRAINTRUST_ORG_NAME: "Test",
          BRAINTRUST_E2E_RUN_CONTEXT_DIR: dir,
        },
      },
    );
    expect(stdout).toContain("e2e-published");
    expect(stdout).toContain("e2e-legacy");
    expect(stdout).not.toContain("e2e-local-only");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
