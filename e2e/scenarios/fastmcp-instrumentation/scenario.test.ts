import { describe, test } from "vitest";
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
  ["fastmcp-v3", "fastmcp-v3-latest", "fastmcp-v4", "fastmcp-v4-latest"].map(
    async (dependency) => ({
      dependency,
      version: await readInstalledPackageVersion(scenarioDir, dependency),
    }),
  ),
);

describe.concurrent("variants", () => {
  for (const { dependency, version } of variants) {
    describeVariant(`${dependency} ${version}`, () => {
      for (const mode of ["wrapped", "auto", "both"]) {
        for (const captureContent of [true, false]) {
          test(`${mode}, captureContent=${captureContent}`, async ({
            expect,
          }) => {
            await withScenarioHarness(async (harness) => {
              await harness.runNodeScenarioDir({
                scenarioDir,
                entry: "scenario.mjs",
                nodeArgs: [
                  "--import",
                  `${scenarioDir}/configure.mjs`,
                  ...(mode === "wrapped"
                    ? []
                    : ["--import", "braintrust/hook.mjs"]),
                ],
                env: {
                  FASTMCP_MCP_ENABLED: mode === "both" ? "1" : "0",
                  FASTMCP_PACKAGE: dependency,
                  FASTMCP_CJS: dependency.endsWith("latest") ? "0" : "1",
                  FASTMCP_WRAPPED: mode === "auto" ? "0" : "1",
                  MCP_CAPTURE_CONTENT: captureContent ? "1" : "0",
                  BRAINTRUST_CAPTURE_ATTACHMENTS: "0",
                },
                runContext: {
                  cassette: false,
                  originalScenarioDir,
                  variantKey: dependency,
                },
              });
              const events = harness.events();
              expect(
                findLatestSpan(events, "fastmcp-instrumentation-root"),
              ).toBeDefined();
              for (const kind of ["session", "stateless"]) {
                const operation = findLatestSpan(events, `fastmcp-${kind}`)!;
                const requests = findChildSpans(
                  events,
                  "tools/call get_weather",
                  operation.span.id,
                );
                expect(requests).toHaveLength(1);
                const [weather] = requests;
                expect(weather.span.type).toBe("tool");
                expect(spanInstrumentationName(weather)).toBe("fastmcp");
                expect(weather.row.metadata).toMatchObject({
                  "mcp.method.name": "tools/call",
                  "gen_ai.operation.name": "execute_tool",
                  "gen_ai.tool.name": "get_weather",
                  "network.protocol.name": "http",
                });
                expect(weather.row.metadata?.["mcp.session.id"]).toEqual(
                  kind === "session" ? expect.any(String) : undefined,
                );
                expect(
                  findChildSpans(events, "weather-lookup", weather.span.id),
                ).toHaveLength(1);
                const [alerts] = findChildSpans(
                  events,
                  "tools/call get_alerts",
                  operation.span.id,
                );
                expect(alerts.row.metadata?.["error.type"]).toBe("tool_error");
                expect(alerts.row.error).toContain(
                  captureContent
                    ? "Alert service unavailable"
                    : "Tool returned an error result",
                );
                if (captureContent) {
                  expect(weather.input).toEqual({ city: "Vienna" });
                  expect(weather.output).toMatchObject({
                    content: [{ type: "text", text: "Sunny in Vienna" }],
                  });
                  const [map] = findChildSpans(
                    events,
                    "tools/call render_map",
                    operation.span.id,
                  );
                  expect(map.output).toMatchObject({
                    content: [{ type: "image", data: "<omitted>" }],
                  });
                  expect(
                    findChildSpans(
                      events,
                      "resources/read",
                      operation.span.id,
                    )[0].output,
                  ).toMatchObject({
                    contents: [
                      { uri: "notes://forecast", text: "Bring an umbrella." },
                    ],
                  });
                  expect(
                    findChildSpans(
                      events,
                      "prompts/get forecast",
                      operation.span.id,
                    )[0].output,
                  ).toMatchObject({
                    messages: [
                      {
                        role: "user",
                        content: {
                          type: "text",
                          text: "What is the forecast for Vienna?",
                        },
                      },
                    ],
                  });
                }
              }
              for (const event of events.filter(
                (event) => spanInstrumentationName(event) === "fastmcp",
              )) {
                expect(event.span.ended).toBe(true);
                if (!captureContent) {
                  expect(event.input).toBeUndefined();
                  expect(event.output).toBeUndefined();
                }
              }
              await matchSpanTreeSnapshot(
                events.map((event) => ({
                  event,
                  fields: {
                    ...spanTreeFields(event),
                    metadata: event.row.metadata && {
                      ...event.row.metadata,
                      ...(event.row.metadata["client.port"] !== undefined
                        ? { "client.port": "<port>" }
                        : {}),
                    },
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
                  `${dependency}${captureContent ? "" : "-no-content"}.span-tree.json`,
                ),
                { snapshotExpect: expect },
              );
            });
          });
        }
      }
    });
  }
});
