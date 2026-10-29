import { describe, expect, test } from "vitest";
import { describeVariant } from "../../helpers/describe-variant";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
  withScenarioHarness,
} from "../../helpers/scenario-harness";
import { matchSpanTreeSnapshot, spanTreeFields } from "../../helpers/span-tree";
import {
  findChildSpans,
  findLatestSpan,
  spanInstrumentationName,
} from "../../helpers/trace-selectors";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});
const variants = await Promise.all(
  [
    "mcp-handler-v1",
    "mcp-handler-v1-latest",
    "mcp-handler-v2",
    "mcp-handler-v2-latest",
  ].map(async (dependencyName) => ({
    dependencyName,
    version: await readInstalledPackageVersion(scenarioDir, dependencyName),
  })),
);

describe.concurrent("variants", () => {
  for (const { dependencyName, version } of variants) {
    for (const captureContent of [false, true]) {
      describeVariant(
        `${dependencyName} ${version}, captureContent=${captureContent}`,
        () => {
          for (const mode of [
            "wrapped",
            "auto",
            "both",
            "both-plugins",
            "disabled",
          ]) {
            test(`${mode} instrumentation`, async ({
              expect: snapshotExpect,
            }) => {
              await withScenarioHarness(async (harness) => {
                await harness.runNodeScenarioDir({
                  scenarioDir,
                  entry: "scenario.mjs",
                  env: {
                    MCP_HANDLER_PACKAGE: dependencyName,
                    MCP_HANDLER_CJS: dependencyName.endsWith("latest")
                      ? "0"
                      : "1",
                    MCP_HANDLER_WRAPPED: mode === "auto" ? "0" : "1",
                    MCP_CAPTURE_CONTENT: captureContent ? "1" : "0",
                    MCP_ENABLED: mode === "both-plugins" ? "1" : "0",
                    MCP_HANDLER_DISABLED: mode === "disabled" ? "1" : "0",
                  },
                  nodeArgs:
                    mode === "wrapped"
                      ? []
                      : [
                          "--import",
                          `${scenarioDir}/configure.mjs`,
                          "--import",
                          "braintrust/hook.mjs",
                        ],
                  runContext: {
                    cassette: false,
                    originalScenarioDir,
                    variantKey: dependencyName,
                  },
                });
                const events = harness.events();
                const root = findLatestSpan(
                  events,
                  "mcp-handler-instrumentation-root",
                );
                expect(root).toBeDefined();
                if (mode === "disabled") {
                  expect(
                    events.filter((event) =>
                      ["mcp", "mcp-handler"].includes(
                        spanInstrumentationName(event) ?? "",
                      ),
                    ),
                  ).toHaveLength(0);
                  return;
                }
                const spans = events.filter(
                  (event) => spanInstrumentationName(event) === "mcp-handler",
                );
                expect(spans).toHaveLength(
                  dependencyName.includes("v1") ? 12 : 13,
                );
                expect(spans.every((span) => span.span.ended)).toBe(true);
                const progress = findLatestSpan(
                  events,
                  "tools/call report_progress",
                );
                const [notice] = findChildSpans(
                  events,
                  "notifications/progress",
                  progress?.span.id,
                );
                expect(notice?.row.metadata).toMatchObject({
                  "mcp.notification.direction": "outgoing",
                  "mcp.progress.token": "progress",
                  "mcp.progress.current": 1,
                  "mcp.progress.total": 1,
                });
                expect(spanInstrumentationName(notice!)).toBe("mcp-handler");
                const weather = findChildSpans(
                  events,
                  "tools/call get_weather",
                  root!.span.id,
                );
                expect(weather).toHaveLength(
                  dependencyName.includes("v1") ? 3 : 4,
                );
                const successfulWeather = weather.filter(
                  (span) => !span.row.error,
                );
                expect(successfulWeather).toHaveLength(
                  dependencyName.includes("v1") ? 2 : 3,
                );
                for (const span of successfulWeather) {
                  expect(span.span.type).toBe("tool");
                  expect(span.row.metadata).toMatchObject({
                    "mcp.method.name": "tools/call",
                    "gen_ai.tool.name": "get_weather",
                    "network.protocol.name": "http",
                  });
                  expect(
                    findChildSpans(events, "weather-lookup", span.span.id),
                  ).toHaveLength(1);
                  if (captureContent) {
                    expect(span.input).toMatchObject({
                      city: expect.any(String),
                    });
                    expect(span.output).toMatchObject({
                      content: [
                        {
                          type: "text",
                          text: expect.stringMatching(/^Sunny in /),
                        },
                      ],
                    });
                  }
                }
                const alerts = findLatestSpan(events, "tools/call get_alerts");
                expect(alerts?.row.metadata?.["error.type"]).toBe("tool_error");
                expect(alerts?.row.error).toContain(
                  captureContent
                    ? "Alert service unavailable"
                    : "Tool returned an error result",
                );
                expect(
                  findLatestSpan(events, "acme/missing")?.row.metadata?.[
                    "rpc.response.status_code"
                  ],
                ).toBe("-32601");
                const ping = findLatestSpan(events, "ping");
                expect(ping).toBeDefined();
                expect(ping!.span.rootId).not.toBe(root!.span.rootId);
                expect(
                  findLatestSpan(events, "tools/list")?.output,
                ).toBeUndefined();
                if (!captureContent) {
                  for (const span of spans) {
                    expect(span.input).toBeUndefined();
                    expect(span.output).toBeUndefined();
                  }
                }
                expect(JSON.stringify(events)).not.toContain("private-token");
                expect(JSON.stringify(spans)).not.toContain("hidden");
                await matchSpanTreeSnapshot(
                  events.map((event) => ({
                    event,
                    fields: {
                      ...spanTreeFields(event),
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
                  resolveFileSnapshotPath(
                    import.meta.url,
                    `${dependencyName}${captureContent ? "" : "-no-content"}.span-tree.json`,
                  ),
                  { snapshotExpect },
                );
              });
            });
          }
        },
      );
    }
  }
});
