import { beforeAll, describe, expect, test } from "vitest";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";
import {
  effectiveScenarioTimeoutMs,
  withScenarioHarness,
  type ScenarioRunContext,
} from "../../helpers/scenario-harness";
import { findChildSpans, findLatestSpan } from "../../helpers/trace-selectors";
import {
  matchSpanTreeSnapshot,
  spanTreeFields,
  type SpanTreeEntry,
} from "../../helpers/span-tree";

const ROOT_NAME = "cloudflare-agents-e2e-root";
const TOOL_NAME = "DeterministicToolAgent";
const FORBIDDEN_MARKERS = [
  "forbidden-run-id-marker",
  "forbidden-parent-tool-call-marker",
  "forbidden-input-preview-marker",
  "forbidden-display-marker",
  "secret-summary",
  "secret-agent-type",
];

type RunCloudflareAgentsScenario = (harness: {
  runScenarioDir: (options: {
    entry: string;
    env: Record<string, string>;
    runContext?: ScenarioRunContext;
    scenarioDir: string;
    timeoutMs: number;
  }) => Promise<unknown>;
}) => Promise<void>;

function toolSpans(events: CapturedLogEvent[]) {
  const root = findLatestSpan(events, ROOT_NAME);
  return findChildSpans(events, TOOL_NAME, root?.span.id);
}

function toolByCase(events: CapturedLogEvent[], caseName: string) {
  return toolSpans(events).find(
    (event) => isRecord(event.input) && event.input.case === caseName,
  );
}

function summarize(events: CapturedLogEvent[]): SpanTreeEntry[] {
  const root = findLatestSpan(events, ROOT_NAME);
  const tools = toolSpans(events).sort((left, right) =>
    String(isRecord(left.input) ? left.input.case : "").localeCompare(
      String(isRecord(right.input) ? right.input.case : ""),
    ),
  );
  return [root, ...tools].flatMap((event) =>
    event
      ? [
          {
            event,
            fields: {
              ...spanTreeFields(event),
              context: event.context,
            },
          },
        ]
      : [],
  );
}

export function defineCloudflareAgentsAssertions(options: {
  name: string;
  runScenario: RunCloudflareAgentsScenario;
  snapshotName: string;
  testFileUrl: string;
  timeoutMs: number;
}): void {
  const snapshotPath = resolveFileSnapshotPath(
    options.testFileUrl,
    `${options.snapshotName}.span-tree.json`,
  );
  const timeoutMs = effectiveScenarioTimeoutMs(options.timeoutMs);
  const testConfig = { timeout: timeoutMs };

  describe(options.name, () => {
    let events: CapturedLogEvent[] = [];
    let setupError: string | undefined;

    beforeAll(async () => {
      try {
        await withScenarioHarness(async (harness) => {
          await options.runScenario(harness);
          events = harness.events();
        });
      } catch (error) {
        setupError = error instanceof Error ? error.stack : String(error);
      }
    }, timeoutMs);

    test("captures awaited child runs as exact tool spans", testConfig, () => {
      expect(setupError).toBeUndefined();
      const root = findLatestSpan(events, ROOT_NAME);
      const tools = toolSpans(events);

      expect(root).toBeDefined();
      expect(root?.metadata).toMatchObject({
        scenario: "cloudflare-agents-instrumentation",
        testRunId: expect.any(String),
      });
      expect(tools).toHaveLength(4);

      for (const tool of tools) {
        expect(tool.span.name).toBe(TOOL_NAME);
        expect(tool.span.type).toBe("tool");
        expect(tool.span.parentIds).toEqual([root?.span.id]);
        expect(tool.span.rootId).toBe(root?.span.rootId);
        expect(tool.span.started).toBe(true);
        expect(tool.span.ended).toBe(true);
        expect(tool.metrics?.start).toEqual(expect.any(Number));
        expect(tool.metrics?.end).toEqual(expect.any(Number));
        expect(Number(tool.metrics?.end)).toBeGreaterThanOrEqual(
          Number(tool.metrics?.start),
        );
        expect(tool.context).toMatchObject({
          span_origin: {
            name: "braintrust.sdk.javascript",
            instrumentation: { name: "cloudflare-agents" },
            environment: {
              type: "server",
              name: "cloudflare_workers",
            },
          },
        });
      }
    });

    test(
      "records exact inputs, completed outputs, and returned errors",
      testConfig,
      () => {
        expect(setupError).toBeUndefined();
        const success = toolByCase(events, "success");
        const failure = toolByCase(events, "error");
        const concurrentA = toolByCase(events, "concurrent-a");
        const concurrentB = toolByCase(events, "concurrent-b");

        expect(success?.input).toEqual({
          case: "success",
          delayMs: 10,
          value: "allowed-success",
        });
        expect(success?.output).toEqual({
          case: "success",
          echoed: "allowed-success",
        });
        expect(success?.row.error).toBeUndefined();

        expect(failure?.input).toEqual({
          case: "error",
          delayMs: 10,
          value: "allowed-error",
        });
        expect(failure?.output).toBeUndefined();
        expect(failure?.row.error).toBe("deterministic child failure");

        expect(concurrentA?.output).toEqual({
          case: "concurrent-a",
          echoed: "allowed-a",
        });
        expect(concurrentB?.output).toEqual({
          case: "concurrent-b",
          echoed: "allowed-b",
        });
        expect(toolByCase(events, "detached")).toBeUndefined();
      },
    );

    test(
      "keeps concurrent child spans as overlapping siblings",
      testConfig,
      () => {
        expect(setupError).toBeUndefined();
        const concurrentA = toolByCase(events, "concurrent-a");
        const concurrentB = toolByCase(events, "concurrent-b");

        expect(concurrentA).toBeDefined();
        expect(concurrentB).toBeDefined();
        expect(concurrentA?.span.parentIds).toEqual(
          concurrentB?.span.parentIds,
        );
        expect(Number(concurrentA?.metrics?.start)).toBeLessThan(
          Number(concurrentB?.metrics?.end),
        );
        expect(Number(concurrentB?.metrics?.start)).toBeLessThan(
          Number(concurrentA?.metrics?.end),
        );
      },
    );

    test("does not leak framework control fields", testConfig, () => {
      expect(setupError).toBeUndefined();
      const serialized = JSON.stringify(toolSpans(events));
      for (const marker of FORBIDDEN_MARKERS) {
        expect(serialized).not.toContain(marker);
      }
      for (const tool of toolSpans(events)) {
        const metadata = tool.metadata ?? {};
        expect(metadata).not.toHaveProperty("runId");
        expect(metadata).not.toHaveProperty("agentType");
        expect(metadata).not.toHaveProperty("summary");
        expect(metadata).not.toHaveProperty("status");
      }
    });

    test("matches the span tree snapshot", testConfig, async () => {
      expect(setupError).toBeUndefined();
      await matchSpanTreeSnapshot(summarize(events), snapshotPath);
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
