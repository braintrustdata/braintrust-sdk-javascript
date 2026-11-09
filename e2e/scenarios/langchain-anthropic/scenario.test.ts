import { expect, test } from "vitest";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
  withScenarioHarness,
} from "../../helpers/scenario-harness";
import { matchSpanTreeSnapshot, spanTreeFields } from "../../helpers/span-tree";
import { findChildSpans, findLatestSpan } from "../../helpers/trace-selectors";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});
const TIMEOUT_MS = 90_000;

for (const dependencyName of [
  "langchain-anthropic-v1",
  "langchain-anthropic-v1-latest",
]) {
  const version = await readInstalledPackageVersion(
    scenarioDir,
    dependencyName,
  );
  test(
    `Anthropic ${version} preserves model attribution with manual and automatic instrumentation`,
    {
      timeout: TIMEOUT_MS,
    },
    async () => {
      await withScenarioHarness(async ({ events, runNodeScenarioDir }) => {
        await runNodeScenarioDir({
          scenarioDir,
          entry: "scenario.mjs",
          timeoutMs: TIMEOUT_MS,
          nodeArgs: ["--import", "braintrust/hook.mjs"],
          env: {
            LANGCHAIN_ANTHROPIC_PACKAGE_NAME: dependencyName,
            // Isolate the LangChain trace contract from direct provider tracing.
            BRAINTRUST_DISABLE_INSTRUMENTATION: "anthropic",
          },
          runContext: { variantKey: dependencyName, originalScenarioDir },
        });

        const captured = events();
        const root = findLatestSpan(captured, "langchain-anthropic-root");
        expect(root).toBeDefined();
        for (const mode of ["manual", "auto"]) {
          for (const operation of ["invoke", "streaming-invoke", "stream"]) {
            const parent = findLatestSpan(
              captured,
              `anthropic-${mode}-${operation}`,
            );
            expect(parent?.span.parentIds).toEqual([root?.span.id]);
            const spans = findChildSpans(
              captured,
              "ChatAnthropic",
              parent?.span.id,
            );
            expect(spans).toHaveLength(1);
            const span = spans[0];
            expect(span.span.type).toBe("llm");
            expect(span.row.metadata).toMatchObject({
              model: "claude-haiku-4-5-20251001",
            });
            expect(span.metrics?.prompt_tokens).toBeGreaterThan(0);
            expect(span.metrics?.completion_tokens).toBeGreaterThan(0);
            expect(span.metrics?.tokens).toBe(
              span.metrics!.prompt_tokens + span.metrics!.completion_tokens,
            );
            if (operation !== "invoke") {
              expect(span.metrics?.time_to_first_token).toBeGreaterThanOrEqual(
                0,
              );
            }
          }
        }
        await matchSpanTreeSnapshot(
          captured.map((event) => ({
            event,
            fields: { ...spanTreeFields(event), context: event.row.context },
          })),
          resolveFileSnapshotPath(
            import.meta.url,
            `${dependencyName}.span-tree.json`,
          ),
        );
      });
    },
  );
}

for (const dependencyName of [
  "langchain-anthropic-v1",
  "langchain-anthropic-v1-latest",
]) {
  test(
    `Anthropic retains streaming timing without model payloads or usage (${dependencyName})`,
    { timeout: TIMEOUT_MS },
    async () => {
      await withScenarioHarness(async ({ events, runNodeScenarioDir }) => {
        await runNodeScenarioDir({
          scenarioDir,
          entry: "scenario.mjs",
          timeoutMs: TIMEOUT_MS,
          nodeArgs: [
            "--import",
            "./capture-config.mjs",
            "--import",
            "braintrust/hook.mjs",
          ],
          env: {
            LANGCHAIN_ANTHROPIC_PACKAGE_NAME: dependencyName,
            DISABLE_LANGCHAIN_CAPTURE: "1",
          },
          runContext: { variantKey: dependencyName, originalScenarioDir },
        });
        const captured = events();
        for (const mode of ["manual", "auto"]) {
          for (const operation of ["invoke", "streaming-invoke", "stream"]) {
            const parent = findLatestSpan(
              captured,
              `anthropic-${mode}-${operation}`,
            );
            const spans = findChildSpans(
              captured,
              "ChatAnthropic",
              parent?.span.id,
            );
            expect(spans).toHaveLength(1);
            const span = spans[0];
            expect(span.input).toBeUndefined();
            expect(span.output).toBeUndefined();
            expect(span.row.metadata).toMatchObject({
              model: "claude-haiku-4-5-20251001",
            });
            expect(
              Object.keys(span.metrics ?? {}).filter((key) =>
                key.includes("tokens"),
              ),
            ).toEqual([]);
            expect(span.metrics?.end).toBeTypeOf("number");
            if (operation !== "invoke") {
              expect(span.metrics?.time_to_first_token).toBeGreaterThanOrEqual(
                0,
              );
            }
            const provider = captured.filter(
              (event) =>
                event.span.name === "anthropic.messages.create" &&
                event.span.parentIds.includes(parent!.span.id!) &&
                typeof event.metrics?.tokens === "number" &&
                event.metrics.tokens > 0,
            );
            expect(provider).toHaveLength(1);
            expect(provider[0].input).toBeDefined();
            expect(provider[0].output).toBeDefined();
          }
        }
        expect(
          captured.filter(
            (event) =>
              typeof event.metrics?.tokens === "number" &&
              event.metrics.tokens > 0,
          ),
        ).toHaveLength(6);
      });
    },
  );
}
