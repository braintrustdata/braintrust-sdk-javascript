import { expect, test } from "vitest";
import {
  formatJsonFileSnapshot,
  resolveFileSnapshotPath,
} from "../../helpers/file-snapshot";
import type { Json } from "../../helpers/normalize";
import {
  prepareScenarioDir,
  resolveScenarioDir,
  withScenarioHarness,
} from "../../helpers/scenario-harness";
import { E2E_TAGS } from "../../helpers/tags";
import {
  extractOtelSpans,
  summarizeEvent,
  summarizeRequest,
} from "../../helpers/trace-summary";
import { findLatestSpan } from "../../helpers/trace-selectors";

const scenarioDir = await prepareScenarioDir({
  scenarioDir: resolveScenarioDir(import.meta.url),
});

const TIMEOUT_MS = 180_000;
const RESULT_MARKER = "NEXTJS_E2E_RESULT ";

type RuntimeResponse = {
  body: {
    instrumentationRegistered: boolean;
    loggerSpanName: string;
    otelSpanName: string;
    projectName: string;
    route: string;
    runtime: "edge" | "nodejs";
    success: boolean;
    testRunId: string;
  };
  runtime: "edge" | "nodejs";
  status: number;
};

function parseScenarioResponses(stdout: string): RuntimeResponse[] {
  const line = stdout
    .split("\n")
    .find((entry) => entry.startsWith(RESULT_MARKER));

  if (!line) {
    throw new Error(`Scenario output did not contain ${RESULT_MARKER}`);
  }

  return JSON.parse(line.slice(RESULT_MARKER.length)) as RuntimeResponse[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeProjectRegisterRequestSummary(
  summary: Record<string, unknown>,
) {
  if (summary.path !== "/api/project/register") {
    return summary;
  }

  const orgId =
    isObject(summary.jsonBody) && typeof summary.jsonBody.org_id === "string"
      ? summary.jsonBody.org_id
      : "mock-org-id";

  return {
    ...summary,
    jsonBody: {
      org_id: orgId,
      project_name: "<project_name>",
    },
    rawBody: JSON.stringify({
      project_name: "<project_name>",
      org_id: orgId,
    }),
  };
}

function dedupeProjectRegisterRequestSummaries(
  summaries: Record<string, unknown>[],
) {
  const seen = new Set<string>();

  return summaries.filter((summary) => {
    if (summary.path !== "/api/project/register") {
      return true;
    }

    const key = JSON.stringify(summary);
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

test(
  "nextjs-instrumentation builds a Next.js app and captures Node and Edge runtime traces",
  {
    tags: [E2E_TAGS.hermetic],
    timeout: TIMEOUT_MS,
  },
  async () => {
    await withScenarioHarness(
      async ({
        requestCursor,
        requestsAfter,
        runScenarioDir,
        testRunEvents,
        testRunId,
      }) => {
        const cursor = requestCursor();
        const result = await runScenarioDir({
          scenarioDir,
          timeoutMs: TIMEOUT_MS,
        });
        const responses = parseScenarioResponses(result.stdout);

        expect(responses).toHaveLength(2);
        expect(responses.map((response) => response.runtime).sort()).toEqual([
          "edge",
          "nodejs",
        ]);

        for (const response of responses) {
          expect(response.status).toBe(200);
          expect(response.body.success).toBe(true);
          expect(response.body.testRunId).toBe(testRunId);
          expect(response.body.route).toBe(
            `/api/smoke-test/${response.runtime === "nodejs" ? "node" : response.runtime}`,
          );
        }

        const events = testRunEvents();
        const edgeSpan = findLatestSpan(events, "nextjs edge logger span");
        const nodeSpan = findLatestSpan(events, "nextjs nodejs logger span");

        expect(edgeSpan).toBeDefined();
        expect(nodeSpan).toBeDefined();
        expect(edgeSpan?.row.metadata).toMatchObject({
          runtime: "edge",
          scenario: "nextjs-instrumentation",
          testRunId,
          transport: "http",
        });
        expect(nodeSpan?.row.metadata).toMatchObject({
          runtime: "nodejs",
          scenario: "nextjs-instrumentation",
          testRunId,
          transport: "http",
        });

        const requests = requestsAfter(
          cursor,
          (request) =>
            request.path === "/api/apikey/login" ||
            request.path === "/api/project/register" ||
            request.path === "/logs3" ||
            request.path === "/otel/v1/traces",
        );

        expect(requests.some((request) => request.path === "/logs3")).toBe(
          true,
        );
        expect(
          requests.some((request) => request.path === "/otel/v1/traces"),
        ).toBe(true);

        const otelRequests = requests.filter(
          (request) => request.path === "/otel/v1/traces",
        );
        const otelSpans = otelRequests.flatMap((request) =>
          extractOtelSpans(request.jsonBody),
        );

        expect(otelSpans.map((span) => span.name)).toContain(
          "nextjs edge otel span",
        );
        expect(otelSpans.map((span) => span.name)).toContain(
          "nextjs nodejs otel span",
        );

        if (otelRequests[0]) {
          expect(otelRequests[0].headers["x-bt-parent"]).toContain(
            testRunId.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
          );
        }

        await expect(
          formatJsonFileSnapshot(
            responses.map((response) => ({
              body: response.body,
              runtime: response.runtime,
              status: response.status,
            })) as Json,
          ),
        ).toMatchFileSnapshot(
          resolveFileSnapshotPath(import.meta.url, "route-responses.json"),
        );

        await expect(
          formatJsonFileSnapshot(
            [edgeSpan, nodeSpan].map((event) => summarizeEvent(event!)) as Json,
          ),
        ).toMatchFileSnapshot(
          resolveFileSnapshotPath(import.meta.url, "span-events.json"),
        );

        await expect(
          formatJsonFileSnapshot(
            otelSpans
              .filter(
                (span) =>
                  span.name === "nextjs edge otel span" ||
                  span.name === "nextjs nodejs otel span",
              )
              .map((span) => ({
                attributes: {
                  runtime: span.attributes.runtime ?? null,
                  scenario: span.attributes.scenario ?? null,
                  testRunId: span.attributes.testRunId ?? null,
                },
                hasParent: !!span.parentSpanId,
                name: span.name,
              })) as Json,
          ),
        ).toMatchFileSnapshot(
          resolveFileSnapshotPath(import.meta.url, "otel-spans.json"),
        );

        await expect(
          formatJsonFileSnapshot(
            dedupeProjectRegisterRequestSummaries(
              requests.map((request) => {
                const summary = summarizeRequest(request, {
                  includeHeaders: ["content-type", "x-bt-parent"],
                  normalizeJsonRawBody: request.path === "/logs3",
                }) as Record<string, unknown>;

                if (request.path === "/otel/v1/traces") {
                  return {
                    ...summary,
                    jsonBody: "<omitted>",
                    rawBody: "<omitted>",
                    headers:
                      summary.headers && typeof summary.headers === "object"
                        ? {
                            ...(summary.headers as Record<string, unknown>),
                            "x-bt-parent": "<x-bt-parent>",
                          }
                        : summary.headers,
                  };
                }

                return normalizeProjectRegisterRequestSummary(summary);
              }),
            ) as Json,
          ),
        ).toMatchFileSnapshot(
          resolveFileSnapshotPath(import.meta.url, "request-flow.json"),
        );
      },
    );
  },
);
