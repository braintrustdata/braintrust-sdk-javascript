import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { auditCassettes } from "../scripts/cassette-audit.mjs";
import { withScenarioHarness } from "./scenario-harness";

let dir: string;
let cassetteDir: string;
let contextDir: string;
let reportPath: string;
let report: {
  success: boolean;
  numFailedTests: number;
  numFailedTestSuites: number;
  testResults: {
    name: string;
    status: string;
    assertionResults: { status: string }[];
  }[];
};

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "braintrust-cassette-audit-"));
  cassetteDir = path.join(dir, "scenarios", "selected", "__cassettes__");
  contextDir = path.join(dir, "context");
  reportPath = path.join(dir, "results.json");
  await mkdir(cassetteDir, { recursive: true });
  await mkdir(contextDir);
  const testFile = path.join(dir, "scenarios", "selected", "scenario.test.ts");
  await writeFile(testFile, "");
  for (const key of ["actual", "default", "display", "stale"]) {
    await writeFile(path.join(cassetteDir, `${key}.cassette.json`), "{}");
    await mkdir(path.join(cassetteDir, `${key}.cassette.blobs`));
    await writeFile(
      path.join(cassetteDir, `${key}.cassette.blobs`, "blob"),
      "bytes",
    );
  }
  await mkdir(path.join(cassetteDir, "orphan.cassette.blobs"));
  await writeFile(path.join(cassetteDir, "notes.txt"), "keep");
  const otherDir = path.join(dir, "scenarios", "unselected", "__cassettes__");
  await mkdir(otherDir, { recursive: true });
  await writeFile(path.join(otherDir, "other.cassette.json"), "{}");
  await writeFile(path.join(otherDir, "..", "scenario.test.ts"), "");
  report = {
    success: true,
    numFailedTests: 0,
    numFailedTestSuites: 0,
    testResults: [
      {
        name: testFile,
        status: "passed",
        assertionResults: [{ status: "passed" }],
      },
    ],
  };
  await writeFile(reportPath, JSON.stringify(report));
  await writeFile(
    path.join(contextDir, "run-context-1.ndjson"),
    [
      {
        scenarioDirName: "selected",
        variantKey: "display",
        cassetteVariantKey: "actual",
      },
      { scenarioDirName: "selected", cassetteVariantKey: "default" },
      {
        scenarioDirName: "selected",
        variantKey: "stale",
        cassetteVariantKey: null,
      },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n"),
  );
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

it("records resolved cassette usage for expected failures and explicit opt-outs", async () => {
  vi.stubEnv("BRAINTRUST_E2E_RUN_CONTEXT_DIR", contextDir);
  vi.stubEnv("BRAINTRUST_E2E_CASSETTE_MODE", "replay");
  const scenarioDir = path.dirname(cassetteDir);
  await writeFile(
    path.join(scenarioDir, "failure.mjs"),
    "process.exitCode = 1;",
  );
  await writeFile(path.join(scenarioDir, "success.mjs"), "");
  await withScenarioHarness(
    async (harness) => {
      await expect(
        harness.runNodeScenarioDir({
          scenarioDir,
          entry: "failure.mjs",
          runContext: {
            originalScenarioDir: scenarioDir,
            variantKey: "display",
            cassette: { variantKey: "expected-error" },
          },
        }),
      ).rejects.toThrow();
      await harness.runNodeScenarioDir({
        scenarioDir,
        entry: "success.mjs",
        runContext: {
          originalScenarioDir: scenarioDir,
          variantKey: "actual",
          cassette: false,
        },
      });
    },
    { forwardToProduction: false },
  );
  const records = (
    await readFile(
      path.join(contextDir, `run-context-${process.pid}.ndjson`),
      "utf8",
    )
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(records).toMatchObject([
    { variantKey: "display", cassetteVariantKey: "expected-error" },
    { variantKey: "actual", cassetteVariantKey: null },
  ]);
});

it("reports unused variants using actual cassette keys without deleting files", async () => {
  const before = await readdir(cassetteDir);
  const result = await auditCassettes({
    e2eDir: dir,
    runContextDir: contextDir,
    reportPath,
  });
  expect(
    result.unused.map((entry: { variantKey: string }) => entry.variantKey),
  ).toEqual(["display", "orphan", "stale"]);
  expect(result.skipped).toEqual([]);
  expect(await readdir(cassetteDir)).toEqual(before);
});

it("cleans unused JSON and blob artifacts while preserving used and unselected fixtures", async () => {
  await auditCassettes({
    e2eDir: dir,
    runContextDir: contextDir,
    reportPath,
    clean: true,
  });
  expect((await readdir(cassetteDir)).sort()).toEqual([
    "actual.cassette.blobs",
    "actual.cassette.json",
    "default.cassette.blobs",
    "default.cassette.json",
    "notes.txt",
  ]);
  expect(
    await readFile(
      path.join(cassetteDir, "actual.cassette.blobs", "blob"),
      "utf8",
    ),
  ).toBe("bytes");
  expect(
    await readFile(
      path.join(
        dir,
        "scenarios",
        "unselected",
        "__cassettes__",
        "other.cassette.json",
      ),
      "utf8",
    ),
  ).toBe("{}");
});

it.each(["skipped", "missing file", "no records"])(
  "preserves a scenario with %s coverage",
  async (mode) => {
    if (mode === "skipped") {
      report.testResults[0].assertionResults.push({ status: "pending" });
      await writeFile(reportPath, JSON.stringify(report));
    } else if (mode === "missing file") {
      await writeFile(path.join(cassetteDir, "..", "other.test.ts"), "");
    } else {
      await rm(path.join(contextDir, "run-context-1.ndjson"));
    }
    const before = await readdir(cassetteDir);
    const result = await auditCassettes({
      e2eDir: dir,
      runContextDir: contextDir,
      reportPath,
      clean: true,
    });
    expect(result.unused).toEqual([]);
    expect(result.skipped).toEqual(["selected"]);
    expect(await readdir(cassetteDir)).toEqual(before);
  },
);

it("refuses cleanup after a failed run", async () => {
  report.success = false;
  report.numFailedTests = 1;
  await writeFile(reportPath, JSON.stringify(report));
  const before = await readdir(cassetteDir);
  await expect(
    auditCassettes({
      e2eDir: dir,
      runContextDir: contextDir,
      reportPath,
      clean: true,
    }),
  ).rejects.toThrow("successful, complete test report");
  expect(await readdir(cassetteDir)).toEqual(before);
});

it.each(["{broken", '{"scenarioDirName":"selected","variantKey":"actual"}'])(
  "rejects malformed or legacy usage records before deleting anything",
  async (record) => {
    await writeFile(path.join(contextDir, "run-context-2.ndjson"), record);
    const before = await readdir(cassetteDir);
    await expect(
      auditCassettes({
        e2eDir: dir,
        runContextDir: contextDir,
        reportPath,
        clean: true,
      }),
    ).rejects.toThrow();
    expect(await readdir(cassetteDir)).toEqual(before);
  },
);

it.each([
  ["--check-cassettes", "-t", "one-test"],
  ["--clean-cassettes", "--shard=1/2"],
  ["--check-cassettes", "scenarios/selected/scenario.test.ts"],
  ["--check-cassettes", "--update"],
  ["--check-cassettes", "nonexistent-scenario"],
])("rejects partial audit arguments %j", async (...args) => {
  await expect(
    promisify(execFile)(process.execPath, [
      fileURLToPath(new URL("../scripts/run-e2e-tests.mjs", import.meta.url)),
      ...args,
    ]),
  ).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining("Select whole scenarios by name"),
  });
});
