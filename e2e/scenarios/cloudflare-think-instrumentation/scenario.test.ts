import { promises as fs } from "node:fs";
import path from "node:path";
import { describe } from "vite-plus/test";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { defineCloudflareThinkAssertions } from "./assertions";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const TIMEOUT_MS = 300_000;
const variants = [];

for (const [aiMajor, minor] of [
  [6, 13],
  [7, 20],
] as const) {
  const sourceDir = path.resolve(
    originalScenarioDir,
    `../../.bt-tmp/generated-scenarios/cloudflare-think-ai${aiMajor}`,
  );
  await fs.rm(sourceDir, { recursive: true, force: true });
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.cp(path.join(originalScenarioDir, "template"), sourceDir, {
    recursive: true,
  });
  await fs.cp(
    path.join(originalScenarioDir, "versions", `ai${aiMajor}`),
    sourceDir,
    { recursive: true },
  );
  for (const lane of [
    "pinned",
    "latest",
    ...(minor === 20 ? ["0.20.1"] : []),
  ]) {
    // Each concurrently running variant writes its own .dev.vars and Worker
    // storage. Share the dependency cache, but not the application directory.
    const scenarioDir = await prepareScenarioDir({ scenarioDir: sourceDir });
    const dependencyName = `cloudflare-think-v0-${minor}${
      lane === "latest" ? "-latest" : lane === "0.20.1" ? "-1" : ""
    }`;
    variants.push({
      aiMajor,
      agentsPackageName: minor === 13 ? "agents-v0-17" : "agents",
      dependencyName,
      label: `0.${minor} ${lane} / AI SDK ${aiMajor}`,
      scenarioDir,
      variantKey: `${dependencyName}-ai${aiMajor}`,
      version: await readInstalledPackageVersion(scenarioDir, dependencyName),
    });
  }
}

const describeVariants =
  process.env.BRAINTRUST_E2E_CASSETTE_MODE === "record" ||
  process.env.BRAINTRUST_E2E_CASSETTE_MODE === "record-missing"
    ? describe
    : describe.concurrent;

describeVariants("Cloudflare Think variants", () => {
  for (const variant of variants) {
    describe(
      `${variant.label} (${variant.version})`,
      { concurrent: false },
      () => {
        for (const mode of ["manual", "auto"] as const) {
          defineCloudflareThinkAssertions({
            usesV7Telemetry: variant.aiMajor === 7 && mode === "auto",
            name: `${mode} Workers/Vite instrumentation`,
            runScenario: async ({ runScenarioDir }) => {
              await runScenarioDir({
                env: {
                  CLOUDFLARE_THINK_INSTRUMENTATION: mode,
                  CLOUDFLARE_THINK_PACKAGE_NAME: variant.dependencyName,
                  CLOUDFLARE_AGENTS_PACKAGE_NAME: variant.agentsPackageName,
                },
                runContext: {
                  originalScenarioDir,
                  variantKey: `${variant.variantKey}-${mode}`,
                },
                scenarioDir: variant.scenarioDir,
                timeoutMs: TIMEOUT_MS,
              });
            },
            snapshotName: `${variant.variantKey}-${mode}`,
            testFileUrl: import.meta.url,
            timeoutMs: TIMEOUT_MS,
          });
        }
      },
    );
  }
});
