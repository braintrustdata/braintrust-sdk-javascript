import { describe } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { defineCloudflareThinkAssertions } from "./assertions";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});
const TIMEOUT_MS = 300_000;
const variants = await Promise.all(
  [
    {
      dependencyName: "cloudflare-think-v0",
      label: "0.13 pinned",
      variantKey: "cloudflare-think-v0",
    },
    {
      dependencyName: "cloudflare-think-v0-latest",
      label: "0.13 latest",
      variantKey: "cloudflare-think-v0-latest",
    },
  ].map(async (variant) => ({
    ...variant,
    version: await readInstalledPackageVersion(
      scenarioDir,
      variant.dependencyName,
    ),
  })),
);

const describeVariants =
  process.env.BRAINTRUST_E2E_CASSETTE_MODE === "record" ||
  process.env.BRAINTRUST_E2E_CASSETTE_MODE === "record-missing"
    ? describe.sequential
    : describe.concurrent;

describeVariants("Cloudflare Think variants", () => {
  for (const variant of variants) {
    describe.sequential(`${variant.label} (${variant.version})`, () => {
      for (const mode of ["manual", "auto"] as const) {
        defineCloudflareThinkAssertions({
          name: `${mode} Workers/Vite instrumentation`,
          runScenario: async ({ runScenarioDir }) => {
            await runScenarioDir({
              env: {
                CLOUDFLARE_THINK_INSTRUMENTATION: mode,
                CLOUDFLARE_THINK_PACKAGE_NAME: variant.dependencyName,
              },
              runContext: {
                originalScenarioDir,
                variantKey: `${variant.variantKey}-${mode}`,
              },
              scenarioDir,
              timeoutMs: TIMEOUT_MS,
            });
          },
          snapshotName: `${variant.variantKey}-${mode}`,
          testFileUrl: import.meta.url,
          timeoutMs: TIMEOUT_MS,
        });
      }
    });
  }
});
