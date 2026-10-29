import { describe } from "vite-plus/test";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { defineCloudflareAIChatAssertions } from "./assertions";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});
const TIMEOUT_MS = 180_000;
const scenarios = await Promise.all(
  [
    {
      dependencyName: "cloudflare-ai-chat-v0",
      variantKey: "cloudflare-ai-chat-v0",
    },
    {
      dependencyName: "cloudflare-ai-chat-v0-latest",
      variantKey: "cloudflare-ai-chat-v0-latest",
    },
  ].map(async (scenario) => ({
    ...scenario,
    version: await readInstalledPackageVersion(
      scenarioDir,
      scenario.dependencyName,
    ),
  })),
);

describe("Cloudflare AI Chat variants", { concurrent: false }, () => {
  for (const scenario of scenarios) {
    describe(
      `@cloudflare/ai-chat ${scenario.version}`,
      { concurrent: false },
      () => {
        for (const mode of ["manual", "auto"] as const) {
          defineCloudflareAIChatAssertions({
            name: `${mode} instrumentation`,
            runScenario: async ({ runNodeScenarioDir }) => {
              await runNodeScenarioDir({
                entry: "scenario.mjs",
                env: {
                  CLOUDFLARE_AI_CHAT_INSTRUMENTATION_MODE: mode,
                  CLOUDFLARE_AI_CHAT_PACKAGE_NAME: scenario.dependencyName,
                },
                runContext: {
                  cassette: {
                    variantKey: scenario.variantKey,
                  },
                  originalScenarioDir,
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
      },
    );
  }
});
