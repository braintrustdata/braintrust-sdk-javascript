import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

// The caller must run the tests in a fresh context directory and only invoke
// this after Vitest exits successfully. The report additionally protects
// scenarios with skipped tests or test files omitted from the run.
export async function auditCassettes({
  e2eDir,
  runContextDir,
  reportPath,
  clean = false,
}) {
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  if (
    report.success !== true ||
    report.numFailedTests !== 0 ||
    report.numFailedTestSuites !== 0 ||
    !Array.isArray(report.testResults)
  ) {
    throw new Error(
      "Cassette audit requires a successful, complete test report.",
    );
  }
  const resultsByFile = new Map(
    report.testResults.map((result) => [
      path.resolve(e2eDir, result.name),
      result,
    ]),
  );
  const variantsByScenario = new Map();
  for (const entry of await readdir(runContextDir)) {
    if (!/^run-context-.*\.ndjson$/.test(entry)) continue;
    for (const line of (
      await readFile(path.join(runContextDir, entry), "utf8")
    ).split("\n")) {
      if (!line.trim()) continue;
      const record = JSON.parse(line);
      if (
        !/^[a-z0-9][a-z0-9-]*$/.test(record.scenarioDirName ?? "") ||
        (record.cassetteVariantKey !== null &&
          typeof record.cassetteVariantKey !== "string")
      ) {
        throw new Error(`Invalid cassette usage record in ${entry}.`);
      }
      const variants =
        variantsByScenario.get(record.scenarioDirName) ?? new Set();
      if (record.cassetteVariantKey !== null) {
        variants.add(record.cassetteVariantKey);
      }
      variantsByScenario.set(record.scenarioDirName, variants);
    }
  }

  const unused = [];
  const skipped = [];
  const scenariosDir = path.join(e2eDir, "scenarios");
  for (const scenario of await readdir(scenariosDir, { withFileTypes: true })) {
    if (!scenario.isDirectory()) continue;
    const scenarioDir = path.join(scenariosDir, scenario.name);
    const cassetteDir = path.join(scenarioDir, "__cassettes__");
    let stat;
    try {
      stat = await lstat(cassetteDir);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (!stat.isDirectory()) continue;
    const artifacts = new Set();
    for (const entry of await readdir(cassetteDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".cassette.json")) {
        artifacts.add(entry.name.slice(0, -".cassette.json".length));
      } else if (
        entry.isDirectory() &&
        entry.name.endsWith(".cassette.blobs")
      ) {
        artifacts.add(entry.name.slice(0, -".cassette.blobs".length));
      }
    }
    if (artifacts.size === 0) continue;
    const testFiles = (await readdir(scenarioDir))
      .filter((name) => name.endsWith(".test.ts"))
      .map((name) => path.join(scenarioDir, name));
    // An unselected scenario is outside the scope of this audit.
    if (!testFiles.some((file) => resultsByFile.has(file))) continue;
    const variants = variantsByScenario.get(scenario.name);
    if (
      !variants ||
      testFiles.some((file) => {
        const result = resultsByFile.get(file);
        return (
          result?.status !== "passed" ||
          !result.assertionResults?.length ||
          result.assertionResults.some((test) => test.status !== "passed")
        );
      })
    ) {
      skipped.push(scenario.name);
      continue;
    }
    for (const variantKey of [...artifacts].sort()) {
      if (!variants.has(variantKey)) {
        unused.push({ scenarioName: scenario.name, cassetteDir, variantKey });
      }
    }
  }

  // Finish validating the entire input before deleting any artifacts.
  if (clean) {
    const { createJsonFileStore } = await import("@braintrust/seinfeld");
    for (const { cassetteDir, variantKey } of unused) {
      await createJsonFileStore({ rootDir: cassetteDir }).delete(variantKey);
    }
  }
  for (const { scenarioName, variantKey } of unused) {
    console.error(
      `[cassettes] ${clean ? "Removed" : "Unused"}: ${scenarioName}/${variantKey}`,
    );
  }
  for (const scenarioName of skipped) {
    console.error(
      `[cassettes] Not checked: ${scenarioName} (incomplete test or usage coverage).`,
    );
  }
  console.error(
    `[cassettes] ${unused.length} unused cassette variant(s)${clean ? " removed" : ""}.`,
  );
  return { unused, skipped };
}
