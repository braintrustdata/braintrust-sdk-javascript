import { describe } from "vitest";
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

describe.sequential("Cloudflare AI Chat variants", () => {
  for (const scenario of scenarios) {
    describe.sequential(`@cloudflare/ai-chat ${scenario.version}`, () => {
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
                  variantKey:
                    mode === "manual"
                      ? scenario.variantKey
                      : `${scenario.variantKey}-auto`,
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
    });
  }
});
