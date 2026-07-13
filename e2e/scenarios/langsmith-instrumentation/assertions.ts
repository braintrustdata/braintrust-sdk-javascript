import { beforeAll, describe, expect, test } from "vitest";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";
import { withScenarioHarness } from "../../helpers/scenario-harness";
import type { ScenarioRunContext } from "../../helpers/scenario-harness";
import { matchSpanTreeSnapshot } from "../../helpers/span-tree";
import { findLatestSpan } from "../../helpers/trace-selectors";

type RunLangSmithScenario = (harness: {
  runNodeScenarioDir: (options: {
    entry: string;
    env?: Record<string, string>;
    nodeArgs: string[];
    runContext?: ScenarioRunContext;
    scenarioDir: string;
    timeoutMs: number;
  }) => Promise<unknown>;
  runScenarioDir: (options: {
    entry: string;
    env?: Record<string, string>;
    runContext?: ScenarioRunContext;
    scenarioDir: string;
    timeoutMs: number;
  }) => Promise<unknown>;
}) => Promise<void>;

const expectedNames = [
  "support-assistant",
  "retrieve-context",
  "ChatOpenAI",
  "lookup-customer-record",
  "manual-rag-pipeline",
  "embed-query",
  "direct-search-index",
  "offline-document-enrichment",
  "extract-keywords",
];

export function defineLangSmithInstrumentationAssertions(options: {
  includeLangChain?: boolean;
  name: string;
  runScenario: RunLangSmithScenario;
  snapshotName: string;
  testFileUrl: string;
  timeoutMs: number;
}): void {
  const spanSnapshotPath = resolveFileSnapshotPath(
    options.testFileUrl,
    `${options.snapshotName}.span-tree.json`,
  );
  const testConfig = { timeout: options.timeoutMs };

  describe(options.name, () => {
    let events: CapturedLogEvent[] = [];

    beforeAll(async () => {
      await withScenarioHarness(async (harness) => {
        await options.runScenario(harness);
        events = harness.events();
      });
    }, options.timeoutMs);

    test("captures the complete LangSmith lifecycle", testConfig, () => {
      for (const name of expectedNames) {
        expect(findLatestSpan(events, name), `missing ${name}`).toBeDefined();
      }

      const roots = [
        "support-assistant",
        "lookup-customer-record",
        "manual-rag-pipeline",
        "direct-search-index",
        "offline-document-enrichment",
      ].map((name) => findLatestSpan(events, name));
      for (const root of roots) {
        expect(root?.span.parentIds).toEqual([]);
        expect(root?.span.rootId).toBe(root?.span.id);
      }

      const assistant = findLatestSpan(events, "support-assistant");
      const retrieval = findLatestSpan(events, "retrieve-context");
      const llm = findLatestSpan(events, "ChatOpenAI");
      expect(
        events.filter((event) => event.span.name === "ChatOpenAI"),
      ).toHaveLength(1);
      expect(retrieval?.span.parentIds).toEqual([assistant?.span.id ?? ""]);
      expect(retrieval?.row).toMatchObject({
        input: { query: "What is the refund window?" },
        metadata: {
          data_source: "support-kb",
          scenario: "langsmith-instrumentation",
        },
        output: { documents: ["Refund policy"] },
        tags: ["knowledge-base"],
      });
      expect(llm?.span.parentIds).toEqual([assistant?.span.id ?? ""]);
      expect(llm?.row).toMatchObject({
        metadata: {
          customer_tier: "enterprise",
          deployment: "local-fixture",
          max_tokens: 64,
          model: "gpt-4o-mini",
          provider: "openai",
          scenario: "langsmith-instrumentation",
          temperature: 0,
        },
        metrics: {
          completion_tokens: 7,
          prompt_cached_tokens: 4,
          prompt_tokens: 18,
          tokens: 25,
        },
        tags: expect.arrayContaining(["chat-completion", "openai"]),
      });
      expect(assistant?.output).toEqual({
        answer: "Refund requests are accepted within 30 days of purchase.",
        source: "Refund policy",
      });

      const failed = findLatestSpan(events, "lookup-customer-record");
      expect(failed?.row.error).toContain("customer record unavailable");

      const manualParent = findLatestSpan(events, "manual-rag-pipeline");
      const manualChild = findLatestSpan(events, "embed-query");
      expect(manualChild?.span.parentIds).toEqual([
        manualParent?.span.id ?? "",
      ]);
      expect(manualChild?.span.type).toBe("llm");
      expect(manualChild?.metrics).toMatchObject({
        prompt_cached_tokens: 1,
        prompt_tokens: 3,
        time_to_first_token: expect.any(Number),
        tokens: 3,
      });

      const clientRun = findLatestSpan(events, "direct-search-index");
      expect(clientRun?.span.id).toBe("11111111-1111-4111-8111-111111111111");
      expect(clientRun?.span.type).toBe("tool");
      expect(clientRun?.output).toEqual({ documents: ["Refund policy"] });

      const batchParent = findLatestSpan(events, "offline-document-enrichment");
      const batchChild = findLatestSpan(events, "extract-keywords");
      expect(batchChild?.span.parentIds).toEqual([batchParent?.span.id ?? ""]);
      expect(batchChild?.span.type).toBe("tool");
    });

    if (options.includeLangChain) {
      test("does not duplicate LangChain callback spans", testConfig, () => {
        expect(
          events.filter((event) => event.span.name === "langchain-dedupe"),
        ).toHaveLength(1);
      });
    }

    test("matches span tree snapshot", testConfig, async () => {
      await matchSpanTreeSnapshot(events, spanSnapshotPath);
    });
  });
}
