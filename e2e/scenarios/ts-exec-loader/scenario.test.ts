import { expect, test } from "vite-plus/test";
import {
  prepareScenarioDir,
  resolveScenarioDir,
  withScenarioHarness,
} from "../../helpers/scenario-harness";
import {
  findLatestChildSpan,
  findLatestSpan,
} from "../../helpers/trace-selectors";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});

for (const dependency of ["ts-exec-v1", "ts-exec-v1-latest"]) {
  for (const braintrustFirst of [false, true]) {
    test(`${dependency} preserves TypeScript exports and execution with Braintrust ${braintrustFirst ? "first" : "last"}`, async () => {
      await withScenarioHarness(
        async ({ events, runNodeScenarioDir, testRunEvents }) => {
          const imports = [dependency, "braintrust/hook.mjs"];
          if (braintrustFirst) imports.reverse();
          const result = await runNodeScenarioDir({
            scenarioDir,
            entry: "scenario.ts",
            nodeArgs: imports.flatMap((specifier) => ["--import", specifier]),
            runContext: {
              originalScenarioDir,
              variantKey: dependency,
            },
          });
          expect(result.stdout).toContain("entry ran");
          const span = findLatestSpan(testRunEvents(), "ts-exec-entry");
          expect(span?.output).toEqual({ config: { a: 1 }, b: 2 });
          expect(
            findLatestChildSpan(events(), "Chat Completion", span?.span.id)
              ?.output,
          ).toBeDefined();
        },
      );
    });
  }
}
