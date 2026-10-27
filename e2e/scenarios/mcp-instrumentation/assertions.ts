import { beforeAll, describe, expect, test } from "vitest";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";
import {
  withScenarioHarness,
  type ScenarioRunContext,
} from "../../helpers/scenario-harness";
import { matchSpanTreeSnapshot } from "../../helpers/span-tree";
import {
  findChildSpans,
  findLatestSpan,
  spanInstrumentationName,
} from "../../helpers/trace-selectors";
import { ROOT_NAME, SCENARIO_NAME } from "./scenario.impl.mjs";

type RunMCPScenario = (harness: {
  runNodeScenarioDir: (options: {
    entry: string;
    env: Record<string, string>;
    nodeArgs: string[];
    runContext?: ScenarioRunContext;
    scenarioDir: string;
  }) => Promise<unknown>;
  runScenarioDir: (options: {
    entry: string;
    env: Record<string, string>;
    runContext?: ScenarioRunContext;
    scenarioDir: string;
  }) => Promise<unknown>;
}) => Promise<void>;

const SESSIONS = [
  {
    operationName: "mcp-http-session-operation",
    spans: ["get_weather", "get_weather", "resources/read", "prompts/get"],
  },
  {
    operationName: "mcp-in-memory-session-operation",
    spans: ["get_weather", "render_map", "get_alerts"],
  },
] as const;

function mcpSpans(
  events: CapturedLogEvent[],
  operationName: string,
): CapturedLogEvent[] {
  const operation = findLatestSpan(events, operationName);
  return [
    ...new Set(SESSIONS.flatMap(({ spans }) => spans as readonly string[])),
  ]
    .flatMap((name) => findChildSpans(events, name, operation?.span.id))
    .sort(
      (left, right) =>
        Number(left.metrics?.start ?? 0) - Number(right.metrics?.start ?? 0),
    );
}

export function defineMCPInstrumentationAssertions(options: {
  name: string;
  runScenario: RunMCPScenario;
  snapshotName: string;
  testFileUrl: string;
}): void {
  const spanSnapshotPath = resolveFileSnapshotPath(
    options.testFileUrl,
    `${options.snapshotName}.span-tree.json`,
  );

  describe(options.name, () => {
    let events: CapturedLogEvent[] = [];

    beforeAll(async () => {
      await withScenarioHarness(async (harness) => {
        await options.runScenario(harness);
        const allEvents = harness.events();
        const root = findLatestSpan(allEvents, ROOT_NAME);
        events = allEvents.filter(
          (event) => event.span.rootId === root?.span.rootId,
        );
      });
    });

    test("captures the scenario root span", () => {
      const root = findLatestSpan(events, ROOT_NAME);
      expect(root).toBeDefined();
      expect(root?.row.metadata).toMatchObject({
        scenario: SCENARIO_NAME,
      });
    });

    test.each(SESSIONS)(
      "correlates requests in $operationName with one session ID",
      ({ operationName, spans }) => {
        const requests = mcpSpans(events, operationName);

        expect(requests.map((span) => span.span.name)).toEqual(spans);
        const sessionIds = new Set(
          requests.map((span) => span.row.metadata?.["mcp.session_id"]),
        );
        expect(sessionIds.size).toBe(1);
        expect([...sessionIds][0]).toEqual(expect.any(String));
        for (const span of requests) {
          expect(spanInstrumentationName(span)).toBe("mcp");
        }
      },
    );

    test("uses a separate session ID per connection", () => {
      const [httpSession, inMemorySession] = SESSIONS.map(
        ({ operationName }) =>
          mcpSpans(events, operationName)[0]?.row.metadata?.["mcp.session_id"],
      );
      expect(httpSession).not.toBe(inMemorySession);
    });

    test("captures tool calls", () => {
      const operation = findLatestSpan(
        events,
        "mcp-in-memory-session-operation",
      );
      const [weather] = findChildSpans(
        events,
        "get_weather",
        operation?.span.id,
      );
      const [alerts] = findChildSpans(events, "get_alerts", operation?.span.id);
      const [map] = findChildSpans(events, "render_map", operation?.span.id);

      expect(weather?.span.type).toBe("tool");
      expect(weather?.input).toEqual({ city: "Tokyo" });
      expect(weather?.output).toMatchObject({
        content: [{ type: "text", text: "Sunny in Tokyo" }],
      });
      expect(weather?.row.metadata).toMatchObject({
        "mcp.method": "tools/call",
      });
      expect(
        findChildSpans(events, "weather-lookup", weather?.span.id),
      ).toHaveLength(1);
      expect(map?.output).toMatchObject({
        content: [{ type: "image", data: "<omitted>", mimeType: "image/png" }],
      });
      expect(alerts?.row.error).toContain("Alert service unavailable");
    });

    test("matches the span tree snapshot", async ({ expect }) => {
      await matchSpanTreeSnapshot(events, spanSnapshotPath, {
        snapshotExpect: expect,
      });
    });
  });
}
