import { describe } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { defineCloudflareAgentsAssertions } from "./assertions";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});
const TIMEOUT_MS = 240_000;
const scenarios = await Promise.all(
  [
    {
      dependencyName: "agents-v0-17",
      label: "v0.17 pinned",
      variantKey: "cloudflare-agents-v0-17",
    },
    {
      dependencyName: "agents-v0-17-latest",
      label: "v0.17 latest",
      variantKey: "cloudflare-agents-v0-17-latest",
    },
  ].map(async (scenario) => ({
    ...scenario,
    version: await readInstalledPackageVersion(
      scenarioDir,
      scenario.dependencyName,
    ),
  })),
);

describe.concurrent("Cloudflare Agents versions", () => {
  for (const scenario of scenarios) {
    describe.sequential(`${scenario.label} (${scenario.version})`, () => {
      for (const mode of ["wrapped", "auto"] as const) {
        defineCloudflareAgentsAssertions({
          name: `${mode} instrumentation`,
          runScenario: async ({ runScenarioDir }) => {
            await runScenarioDir({
              entry: "scenario.ts",
              env: {
                CLOUDFLARE_AGENTS_INSTRUMENTATION_MODE: mode,
                CLOUDFLARE_AGENTS_PACKAGE_NAME: scenario.dependencyName,
              },
              runContext: {
                cassette: false,
                variantKey: scenario.variantKey,
              },
              scenarioDir,
              timeoutMs: TIMEOUT_MS,
            });
          },
          snapshotName: `${scenario.variantKey}-${mode}`,
          testFileUrl: import.meta.url,
          timeoutMs: TIMEOUT_MS,
        });
      }
    });
  }
});
