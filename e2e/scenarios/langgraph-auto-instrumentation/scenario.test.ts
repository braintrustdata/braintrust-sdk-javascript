import { expect, test } from "vite-plus/test";
import {
  formatJsonFileSnapshot,
  resolveFileSnapshotPath,
} from "../../helpers/file-snapshot";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
  withScenarioHarness,
} from "../../helpers/scenario-harness";
import { findLatestSpan } from "../../helpers/trace-selectors";
import { matchSpanTreeSnapshot } from "../../helpers/span-tree";
import { assertLangGraphAutoInstrumentation } from "./assertions";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});
const TIMEOUT_MS = 120_000;
const scenarios = await Promise.all(
  [
    {
      coreDependencyName: "langchain-core-v1",
      langgraphDependencyName: "langchain-langgraph-v1",
      openAIDependencyName: "langchain-openai-v1",
      variantKey: "langgraph-v1",
    },
    {
      coreDependencyName: "langchain-core-v1-latest",
      langgraphDependencyName: "langchain-langgraph-v1-latest",
      openAIDependencyName: "langchain-openai-v1-latest",
      variantKey: "langgraph-v1-latest",
    },
  ].map(async (scenario) => ({
    ...scenario,
    version: await readInstalledPackageVersion(
      scenarioDir,
      scenario.langgraphDependencyName,
    ),
  })),
);

for (const scenario of scenarios) {
  test(
    `langgraph auto-instrumentation captures spans via the braintrust hook (${scenario.version})`,
    {
      timeout: TIMEOUT_MS,
    },
    async () => {
      await withScenarioHarness(
        async ({ events, payloads, runNodeScenarioDir }) => {
          await runNodeScenarioDir({
            entry: "scenario.mjs",
            env: {
              LANGCHAIN_CORE_PACKAGE_NAME: scenario.coreDependencyName,
              LANGCHAIN_OPENAI_PACKAGE_NAME: scenario.openAIDependencyName,
              LANGGRAPH_PACKAGE_NAME: scenario.langgraphDependencyName,
            },
            nodeArgs: ["--import", "braintrust/hook.mjs"],
            runContext: {
              variantKey: scenario.variantKey,
              originalScenarioDir,
            },
            scenarioDir,
            timeoutMs: TIMEOUT_MS,
          });

          const summaries = assertLangGraphAutoInstrumentation({
            capturedEvents: events(),
            payloads: payloads(),
          });

          await matchSpanTreeSnapshot(
            summaries.spanTree,
            resolveFileSnapshotPath(
              import.meta.url,
              `${scenario.variantKey}.span-tree.json`,
            ),
          );
          await expect(
            formatJsonFileSnapshot(summaries.payloadSummary),
          ).toMatchFileSnapshot(
            resolveFileSnapshotPath(
              import.meta.url,
              `${scenario.variantKey}.log-payloads.json`,
            ),
          );
        },
      );
    },
  );
}

for (const scenario of scenarios) {
  test(
    `langgraph retains spans with payload capture disabled (${scenario.version})`,
    { timeout: TIMEOUT_MS },
    async () => {
      await withScenarioHarness(async ({ events, runNodeScenarioDir }) => {
        await runNodeScenarioDir({
          entry: "scenario.mjs",
          env: {
            LANGCHAIN_CORE_PACKAGE_NAME: scenario.coreDependencyName,
            LANGCHAIN_OPENAI_PACKAGE_NAME: scenario.openAIDependencyName,
            LANGGRAPH_PACKAGE_NAME: scenario.langgraphDependencyName,
          },
          nodeArgs: [
            "--import",
            "./capture-config.mjs",
            "--import",
            "braintrust/hook.mjs",
          ],
          runContext: { variantKey: scenario.variantKey, originalScenarioDir },
          scenarioDir,
          timeoutMs: TIMEOUT_MS,
        });
        const captured = events();
        const chainSpans = captured.filter((event) =>
          ["LangGraph", "sayHello", "sayBye", "ChatOpenAI"].includes(
            event.span.name ?? "",
          ),
        );
        expect(chainSpans).toHaveLength(4);
        for (const event of chainSpans) {
          expect(event.input).toBeUndefined();
          expect(event.output).toBeUndefined();
          expect(event.row.metadata).not.toHaveProperty("inputs");
          expect(event.span.parentIds).toHaveLength(1);
          expect(event.metrics?.start).toBeTypeOf("number");
          expect(event.metrics?.end).toBeTypeOf("number");
          expect(
            Object.keys(event.metrics ?? {}).filter((key) =>
              key.includes("tokens"),
            ),
          ).toEqual([]);
        }
        const model = findLatestSpan(captured, "ChatOpenAI");
        expect(model).toBeDefined();
        const root = findLatestSpan(
          captured,
          "langgraph-auto-instrumentation-root",
        )!;
        const graph = findLatestSpan(captured, "LangGraph")!;
        const hello = findLatestSpan(captured, "sayHello")!;
        const bye = findLatestSpan(captured, "sayBye")!;
        expect(graph.span.parentIds).toEqual([root.span.id]);
        expect(hello.span.parentIds).toEqual([graph.span.id]);
        expect(bye.span.parentIds).toEqual([graph.span.id]);
        expect(model?.span.parentIds).toEqual([hello.span.id]);
        const provider = findLatestSpan(captured, "Chat Completion");
        // Callback spans use run IDs; provider spans retain the active SDK parent.
        expect(provider?.span.parentIds).toEqual([root.span.id]);
        expect(provider?.input).toBeDefined();
        expect(provider?.output).toBeDefined();
        expect(provider?.metrics?.tokens).toBeGreaterThan(0);
        expect(
          captured.filter(
            (event) =>
              typeof event.metrics?.tokens === "number" &&
              event.metrics.tokens > 0,
          ),
        ).toHaveLength(1);
      });
    },
  );
}
