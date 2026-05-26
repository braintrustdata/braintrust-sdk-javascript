import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, test } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
  withScenarioHarness,
} from "../../helpers/scenario-harness";

const TIMEOUT_MS = 180_000;
const originalScenarioDir = resolveScenarioDir(import.meta.url);
const generatedScenarioRoot = path.resolve(
  originalScenarioDir,
  "../../.bt-tmp/generated-scenarios/nextjs-auto-instrumentation",
);
const nextVersionScenarios = [
  {
    bundlers: ["webpack"],
    generatedDirName: "nextjs-auto-instrumentation-next-14",
    label: "Next 14",
    versionDir: "next-14",
  },
  {
    bundlers: ["webpack", "turbopack"],
    generatedDirName: "nextjs-auto-instrumentation-next-16",
    label: "Next 16",
    versionDir: "next-16",
  },
] as const;

const preparedScenarios = await Promise.all(
  nextVersionScenarios.map(async (scenario) => {
    const sourceDir = path.join(
      generatedScenarioRoot,
      scenario.generatedDirName,
    );

    await fs.rm(sourceDir, { force: true, recursive: true });
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.cp(path.join(originalScenarioDir, "template"), sourceDir, {
      recursive: true,
    });
    await fs.cp(
      path.join(originalScenarioDir, "versions", scenario.versionDir),
      sourceDir,
      { recursive: true },
    );

    // Next must be installed under the real package name for the CLI, type
    // plugin, and config resolver paths to match user projects. Generate one
    // install root per version instead of using package aliases.
    //
    // Keep real node_modules in the prepared app. Turbopack follows symlink
    // realpaths during its root checks, which can reject cached e2e installs
    // before it applies the explicit root from next.config.mjs.
    const scenarioDir = await prepareScenarioDir({
      linkDependencies: false,
      scenarioDir: sourceDir,
    });
    return {
      ...scenario,
      scenarioDir,
      version: await readInstalledPackageVersion(scenarioDir, "next"),
    };
  }),
);

for (const scenario of preparedScenarios) {
  describe(`nextjs-auto-instrumentation ${scenario.label} (${scenario.version})`, () => {
    for (const bundler of scenario.bundlers) {
      test(
        `${bundler}: Next.js build output contains OpenAI instrumentation`,
        async () => {
          await withScenarioHarness(async ({ runScenarioDir }) => {
            await runScenarioDir({
              env: {
                NEXTJS_E2E_BUNDLER: bundler,
              },
              runContext: {
                cassette: false,
                variantKey: `${scenario.versionDir}-${bundler}`,
              },
              scenarioDir: scenario.scenarioDir,
              timeoutMs: TIMEOUT_MS,
            });
          });
        },
        TIMEOUT_MS,
      );
    }
  });
}
