import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, it } from "vite-plus/test";

it("links published runs while preserving legacy records and excluding local-only runs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "braintrust-e2e-links-"));
  const configPath = path.join(dir, "config.json");
  const shardDir = path.join(dir, "shard-1");
  try {
    await mkdir(shardDir);
    await writeFile(
      configPath,
      JSON.stringify([
        {
          scenarioDirName: "scenario",
          label: "Scenario",
          metadataScenario: "scenario",
        },
        ...["captured", "eval-only", "empty"].map((name) => ({
          scenarioDirName: name,
          label: name,
          metadataScenario: name,
        })),
        {
          scenarioDirName: "grouped",
          label: "Grouped",
          metadataScenario: "grouped",
          variants: [
            {
              variantKey: "v1",
              label: "v1",
              variantKeys: ["v1-manual", "v1-auto"],
            },
            { variantKey: "v2", label: "v2" },
          ],
        },
      ]),
    );
    await writeFile(
      path.join(shardDir, "runs.ndjson"),
      [
        { testRunId: "e2e-published", forwardToProduction: true },
        { testRunId: "e2e-local-only", forwardToProduction: false },
        { testRunId: "e2e-legacy" },
        {
          scenarioDirName: "captured",
          testRunId: "e2e-captured",
          forwardToProduction: true,
          logRootSpanIds: ["trace-without-scenario-metadata"],
          experimentNames: [],
        },
        {
          scenarioDirName: "eval-only",
          testRunId: "e2e-eval",
          forwardToProduction: true,
          logRootSpanIds: [],
          experimentNames: ["eval/with spaces"],
        },
        {
          scenarioDirName: "empty",
          testRunId: "e2e-empty",
          forwardToProduction: true,
          logRootSpanIds: [],
          experimentNames: [],
        },
        ...["manual", "auto"].map((mode) => ({
          scenarioDirName: "grouped",
          variantKey: `v1-${mode}`,
          testRunId: `e2e-${mode}`,
          forwardToProduction: true,
          logRootSpanIds: [`trace-${mode}`],
          experimentNames: [],
        })),
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
    const logsLinks = [...stdout.matchAll(/\[Open logs\]\(([^)]+)\)/g)];
    expect(logsLinks).toHaveLength(3);
    const search = JSON.parse(
      new URL(logsLinks[1][1]).searchParams.get("search")!,
    );
    expect(decodeURIComponent(search.filter[0].text)).toBe(
      '(root_span_id IN ("trace-without-scenario-metadata"))',
    );
    expect(stdout).toContain("/experiments/eval%2Fwith%20spaces");
    expect(stdout).toContain("| empty | N/A | Observed (no captured traces) |");
    expect(stdout).not.toContain("e2e-eval");
    const groupedSearch = JSON.parse(
      new URL(logsLinks[2][1]).searchParams.get("search")!,
    );
    expect(decodeURIComponent(groupedSearch.filter[0].text)).toBe(
      '(root_span_id IN ("trace-manual", "trace-auto"))',
    );
    expect(stdout).toContain("| Grouped (v1) |");
    expect(stdout).toContain("| Observed (2 runs) |");
    expect(stdout).toContain(
      "| Grouped (v2) | N/A | Not observed in this run |",
    );
    expect(stdout).not.toContain("unconfigured variant");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
