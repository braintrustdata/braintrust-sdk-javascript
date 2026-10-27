import { describe } from "vitest";
import { describeVariant } from "../../helpers/describe-variant";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { defineMCPInstrumentationAssertions } from "./assertions";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});

const scenarios = await Promise.all(
  [
    {
      autoEntry: "scenario.cjs.mjs",
      dependencyName: "mcp-sdk-v1",
      line: "v1",
      snapshotName: "mcp-sdk-v1",
      wrapperEntry: "scenario.cjs.ts",
    },
    {
      autoEntry: "scenario.mjs",
      dependencyName: "mcp-sdk-v1-latest",
      line: "v1",
      snapshotName: "mcp-sdk-v1-latest",
      wrapperEntry: "scenario.ts",
    },
    {
      autoEntry: "scenario.cjs.mjs",
      dependencyName: "mcp-server-v2",
      line: "v2",
      snapshotName: "mcp-server-v2",
      wrapperEntry: "scenario.cjs.ts",
    },
    {
      autoEntry: "scenario.mjs",
      dependencyName: "mcp-server-v2-latest",
      line: "v2",
      snapshotName: "mcp-server-v2-latest",
      wrapperEntry: "scenario.ts",
    },
  ].map(async (scenario) => ({
    ...scenario,
    version: await readInstalledPackageVersion(
      scenarioDir,
      scenario.dependencyName,
    ),
  })),
);

describe.concurrent("variants", () => {
  for (const scenario of scenarios) {
    describeVariant(`mcp ${scenario.line} ${scenario.version}`, () => {
      const env = {
        MCP_SDK_LINE: scenario.line,
        MCP_SERVER_PACKAGE_NAME: scenario.dependencyName,
      };
      const runContext = {
        cassette: false,
        originalScenarioDir,
        variantKey: scenario.snapshotName,
      };

      defineMCPInstrumentationAssertions({
        name: "wrapped instrumentation",
        runScenario: async ({ runScenarioDir }) => {
          await runScenarioDir({
            entry: scenario.wrapperEntry,
            env,
            runContext,
            scenarioDir,
          });
        },
        snapshotName: scenario.snapshotName,
        testFileUrl: import.meta.url,
      });

      defineMCPInstrumentationAssertions({
        name: "auto-hook instrumentation",
        runScenario: async ({ runNodeScenarioDir }) => {
          await runNodeScenarioDir({
            entry: scenario.autoEntry,
            env,
            nodeArgs: ["--import", "braintrust/hook.mjs"],
            runContext,
            scenarioDir,
          });
        },
        snapshotName: scenario.snapshotName,
        testFileUrl: import.meta.url,
      });
    });
  }
});
