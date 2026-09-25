import { it } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
  withScenarioHarness,
} from "../../helpers/scenario-harness";
import { assertRecordedReasoning } from "./assertions";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});
const aliases = [
  "openai-v4",
  "openai-v4-latest",
  "openai-v5",
  "openai-v5-latest",
  "openai-v6",
  "openai-v6-latest",
];

// A serial, non-retrying test also stops all later live requests on first failure.
it(
  "retains genuine streamed reasoning through every OpenAI alias and entrypoint",
  {
    retry: 0,
    timeout: 900_000,
  },
  async () => {
    for (const alias of aliases) {
      const version = await readInstalledPackageVersion(scenarioDir, alias);
      for (const mode of ["wrapped", "auto-hook"]) {
        await withScenarioHarness(async (harness) => {
          const options = {
            scenarioDir,
            env: { OPENAI_PACKAGE_NAME: alias },
            runContext: { originalScenarioDir, variantKey: alias },
            timeoutMs: 60_000,
          };
          if (mode === "wrapped") {
            await harness.runScenarioDir({ ...options, entry: "scenario.ts" });
          } else {
            await harness.runNodeScenarioDir({
              ...options,
              entry: "scenario.mjs",
              nodeArgs: ["--import", "braintrust/hook.mjs"],
            });
          }
          await assertRecordedReasoning({
            events: harness.events(),
            originalScenarioDir,
            alias,
            mode,
            version,
            testFileUrl: import.meta.url,
          });
        });
      }
    }
  },
);
