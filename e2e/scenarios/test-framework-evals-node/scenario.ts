import { resolveScenarioDir } from "../../helpers/scenario-harness";
import { runMain, runNodeSubprocess } from "../../helpers/scenario-runtime";

const scenarioDir = resolveScenarioDir(import.meta.url);

async function main() {
  await runNodeSubprocess({
    args: ["--test", "runner.case.mjs"],
    cwd: scenarioDir,
    timeoutMs: 60_000,
  });
}

runMain(main);
