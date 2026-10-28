import { describe } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { defineCursorAgentSDKAssertions } from "./assertions";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});
const TIMEOUT_MS = 420_000;
const variants = await Promise.all(
  [
    {
      dependencyName: "agent-sdk-v0",
      snapshotName: "cursor-agent-sdk-v0",
      variantKey: "agent-sdk-v0",
    },
    {
      dependencyName: "agent-sdk-v0-latest",
      snapshotName: "cursor-agent-sdk-v0-latest",
      variantKey: "agent-sdk-v0-latest",
    },
  ].map(async (variant) => ({
    ...variant,
    version: await readInstalledPackageVersion(
      scenarioDir,
      variant.dependencyName,
    ),
  })),
);

describe.sequential("variants", () => {
  for (const variant of variants) {
    describe(`cursor agent sdk ${variant.version}`, () => {
      defineCursorAgentSDKAssertions({
        name: "auto-hook instrumentation",
        runScenario: async ({ runNodeScenarioDir }) => {
          await runNodeScenarioDir({
            entry: "scenario.mjs",
            env: { AGENT_SDK_PACKAGE_NAME: variant.dependencyName },
            nodeArgs: ["--import", "braintrust/hook.mjs"],
            runContext: {
              originalScenarioDir,
              variantKey: variant.variantKey,
            },
            scenarioDir,
            timeoutMs: TIMEOUT_MS,
          });
        },
        snapshotName: variant.snapshotName,
        testFileUrl: import.meta.url,
        timeoutMs: TIMEOUT_MS,
      });
    });
  }
});
