import { beforeAll, describe, expect, test } from "vite-plus/test";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";
import {
  withScenarioHarness,
  type ScenarioRunContext,
} from "../../helpers/scenario-harness";
import { matchSpanTreeSnapshot, spanTreeFields } from "../../helpers/span-tree";
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
    spans: [
      "tools/call get_weather",
      "tools/call get_weather",
      "resources/read",
      "prompts/get forecast",
    ],
  },
  {
    operationName: "mcp-in-memory-session-operation",
    spans: [
      "tools/call get_weather",
      "tools/call report_progress",
      "tools/call render_map",
      "tools/call get_alerts",
    ],
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
  captureContent: boolean;
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
        events = harness.events();
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
      "records actual session state in $operationName",
      ({ operationName, spans }) => {
        const requests = mcpSpans(events, operationName);

        expect(requests.map((span) => span.span.name)).toEqual(spans);
        const sessionIds = new Set(
          requests.map((span) => span.row.metadata?.["mcp.session.id"]),
        );
        expect(sessionIds.size).toBe(1);
        if (operationName === "mcp-http-session-operation") {
          expect([...sessionIds][0]).toEqual(expect.any(String));
          expect(requests[0]?.row.metadata?.["network.protocol.name"]).toBe(
            "http",
          );
        } else expect([...sessionIds][0]).toBeUndefined();
        for (const span of requests) {
          expect(spanInstrumentationName(span)).toBe("mcp");
        }
      },
    );

    test("captures tool calls", () => {
      const operation = findLatestSpan(
        events,
        "mcp-in-memory-session-operation",
      );
      const [weather] = findChildSpans(
        events,
        "tools/call get_weather",
        operation?.span.id,
      );
      const [alerts] = findChildSpans(
        events,
        "tools/call get_alerts",
        operation?.span.id,
      );
      const [map] = findChildSpans(
        events,
        "tools/call render_map",
        operation?.span.id,
      );

      expect(weather?.span.type).toBe("tool");
      if (options.captureContent) {
        expect(weather?.input).toEqual({ city: "Tokyo" });
        expect(weather?.output).toMatchObject({
          content: [{ type: "text", text: "Sunny in Tokyo" }],
        });
        expect(map?.output).toMatchObject({
          content: [
            { type: "image", data: "<omitted>", mimeType: "image/png" },
          ],
        });
        expect(alerts?.row.error).toContain("Alert service unavailable");
      } else {
        for (const span of events.filter(
          (event) => spanInstrumentationName(event) === "mcp",
        )) {
          expect(span.input).toBeUndefined();
          expect(span.output).toBeUndefined();
        }
        expect(alerts?.row.error).toBe("Tool returned an error result");
      }
      expect(alerts?.row.metadata?.["error.type"]).toBe("tool_error");
      expect(
        alerts?.row.metadata?.["rpc.response.status_code"],
      ).toBeUndefined();
      expect(weather?.row.metadata).toMatchObject({
        "mcp.method.name": "tools/call",
      });
      expect(
        findChildSpans(events, "weather-lookup", weather?.span.id),
      ).toHaveLength(1);
    });

    test("traces server progress notifications under their request", () => {
      const operation = findLatestSpan(
        events,
        "mcp-in-memory-session-operation",
      );
      const [request] = findChildSpans(
        events,
        "tools/call report_progress",
        operation?.span.id,
      );
      const [notice] = findChildSpans(
        events,
        "notifications/progress",
        request?.span.id,
      );
      expect(notice?.row.metadata).toMatchObject({
        "mcp.notification.direction": "outgoing",
        "mcp.progress.token": "0",
        "mcp.progress.current": 1,
        "mcp.progress.total": 2,
        "mcp.progress.percentage": 50,
        "mcp.client.name": "braintrust-e2e-client",
        "mcp.server.name": "braintrust-e2e-weather",
      });
      expect(notice?.row.metadata?.["mcp.protocol.version"]).toEqual(
        expect.any(String),
      );
      if (options.captureContent)
        expect(notice?.output).toMatchObject({
          progressToken: 0,
          progress: 1,
          total: 2,
          message: "working",
        });
      else expect(notice?.output).toBeUndefined();
      const [log] = findChildSpans(
        events,
        "notifications/message",
        request?.span.id,
      );
      expect(log?.row.metadata?.["mcp.logging.data_type"]).toBe("object");
      expect(log?.row.metadata?.["mcp.logging.message"]).toBeUndefined();
      if (options.captureContent) {
        expect(log?.output).toMatchObject({
          data: { type: "image", mimeType: "image/png", data: "<omitted>" },
        });
        expect(JSON.stringify(log?.output)).not.toContain("hidden");
      } else expect(log?.output).toBeUndefined();
    });

    test("keeps an active stdio request open after an unrelated parse error", () => {
      const operation = findLatestSpan(events, "mcp-stdio-error-operation");
      const [request] = findChildSpans(
        events,
        "tools/call wait_for_parse_error",
        operation?.span.id,
      );
      expect(request?.row.error).toBeUndefined();
      expect(request?.row.metadata?.["error.type"]).toBeUndefined();
      expect(request?.span.ended).toBe(true);
      if (options.captureContent)
        expect(request?.output).toMatchObject({
          content: [{ type: "text", text: "completed" }],
        });
    });

    test("captures dispatch failures, discovery, and honored cancellation", () => {
      const operation = findLatestSpan(events, "mcp-lifecycle-operation");
      const [ping] = findChildSpans(events, "ping", operation?.span.id);
      const [discovery] = findChildSpans(
        events,
        "tools/list",
        operation?.span.id,
      );
      const [missing] = findChildSpans(
        events,
        "acme/missing",
        operation?.span.id,
      );
      const [invalid] = findChildSpans(
        events,
        "tools/call get_weather",
        operation?.span.id,
      );
      const [cancelled] = findChildSpans(
        events,
        "tools/call wait_for_cancel",
        operation?.span.id,
      );
      expect(ping?.span.type).toBe("function");
      expect(discovery?.input).toBeUndefined();
      expect(discovery?.output).toBeUndefined();
      expect(missing?.row.error).toBeUndefined();
      expect(missing?.row.metadata?.["error.type"]).toBeUndefined();
      expect(missing?.row.metadata?.["rpc.response.status_code"]).toBe(
        "-32601",
      );
      expect(invalid?.row.error).toEqual(expect.any(String));
      expect(cancelled?.row.metadata?.["mcp.cancelled"]).toBe(true);
      expect(cancelled?.row.error).toBeUndefined();
      expect(cancelled?.output).toBeUndefined();
      const [fallback] = findChildSpans(
        events,
        "acme/cancel",
        operation?.span.id,
      );
      expect(fallback?.row.metadata?.["mcp.cancelled"]).toBe(true);
      expect(fallback?.row.error).toBeUndefined();
      expect(fallback?.output).toBeUndefined();
      expect(
        findChildSpans(events, "notifications/cancelled", operation?.span.id),
      ).toHaveLength(2);
      for (const notice of findChildSpans(
        events,
        "notifications/cancelled",
        operation?.span.id,
      )) {
        expect(notice.row.metadata?.["mcp.cancelled"]).toBeUndefined();
        expect(notice.row.metadata?.["jsonrpc.request.id"]).toBeUndefined();
        expect(notice.row.error).toBeUndefined();
      }
      expect(JSON.stringify(events)).not.toContain(
        "private cancellation reason",
      );
    });

    test("translates protocol metadata and preserves application metadata", () => {
      const operation = findLatestSpan(
        events,
        "mcp-in-memory-session-operation",
      );
      const [weather] = findChildSpans(
        events,
        "tools/call get_weather",
        operation?.span.id,
      );
      expect(weather?.row.metadata).toMatchObject({
        "mcp.client.name": "trace-client",
        "mcp.client.version": "1.0.0",
        "mcp.server.name": "braintrust-e2e-weather",
      });
      if (options.captureContent) {
        expect(weather?.output).toMatchObject({
          structuredContent: { _meta: { application: "preserved" } },
        });
        expect(weather?.output).not.toHaveProperty("_meta");
        expect(weather?.output).not.toHaveProperty("content.0._meta");
      } else expect(weather?.output).toBeUndefined();
    });

    test("starts a new trace without valid MCP context", () => {
      const root = findLatestSpan(events, ROOT_NAME);
      const ping = events.find(
        (event) => event.row.metadata?.["jsonrpc.request.id"] === "106",
      );
      expect(ping).toBeDefined();
      expect(ping?.span.rootId).not.toBe(root?.span.rootId);
      expect(ping?.row.span_parents ?? []).toEqual([]);
      expect(ping?.metrics?.end).toEqual(expect.any(Number));
    });

    test("keeps notification spans active across asynchronous handlers", () => {
      const notice = findLatestSpan(events, "acme/notice");
      expect(notice).toBeDefined();
      expect(notice?.span.type).toBe("function");
      expect(notice?.row.metadata?.["jsonrpc.request.id"]).toBeUndefined();
      expect(
        findChildSpans(events, "notice-work", notice?.span.id),
      ).toHaveLength(1);
      expect(notice?.metrics?.end).toEqual(expect.any(Number));
    });

    test("captures notification validation failures and registered handler work", () => {
      const notices = events.filter(
        (event) => event.span.name === "acme/validated",
      );
      expect(notices).toHaveLength(2);
      const failed = notices.find((event) => event.row.error !== undefined);
      const succeeded = notices.find((event) => event.row.error === undefined);
      expect(failed?.row.metadata?.["error.type"]).toEqual(expect.any(String));
      expect(
        failed?.row.metadata?.["rpc.response.status_code"],
      ).toBeUndefined();
      expect(failed?.metrics?.end).toEqual(expect.any(Number));
      expect(
        findChildSpans(events, "validated-notice-work", succeeded?.span.id),
      ).toHaveLength(1);
    });

    test("matches the span tree snapshot", async ({ expect }) => {
      await matchSpanTreeSnapshot(
        events.map((event) => ({
          event,
          fields: {
            ...spanTreeFields(event),
            // Manual and generated wrappers have different caller stacks.
            // Keep the context contract while normalizing those locations.
            context: event.row.context && {
              ...event.row.context,
              ...(event.row.context.caller_filename !== undefined
                ? { caller_filename: "<caller>" }
                : {}),
              ...(event.row.context.caller_functionname !== undefined
                ? { caller_functionname: "<caller>" }
                : {}),
            },
            metrics: event.metrics,
          },
        })),
        spanSnapshotPath,
        {
          snapshotExpect: expect,
        },
      );
    });
  });
}
