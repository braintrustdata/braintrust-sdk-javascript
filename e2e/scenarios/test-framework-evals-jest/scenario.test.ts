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
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import { E2E_TAGS } from "../../helpers/tags";
import { findLatestSpan } from "../../helpers/trace-selectors";
import { summarizeEvent, summarizeRequest } from "../../helpers/trace-summary";
import { payloadRowsForTestRunId } from "../../helpers/wrapper-contract";

const scenarioDir = await prepareScenarioDir({
  scenarioDir: resolveScenarioDir(import.meta.url),
});
const TIMEOUT_MS = 90_000;

function findEventByCase(events: CapturedLogEvent[], testCase: string) {
  return events.find((event) => {
    const metadata = event.row.metadata as Record<string, unknown> | undefined;
    return metadata?.case === testCase;
  });
}

test(
  "test-framework-evals-jest captures real HTTP traces from a nested Jest runner",
  {
    tags: [E2E_TAGS.hermetic],
    timeout: TIMEOUT_MS,
  },
  async () => {
    await withScenarioHarness(
      async ({
        payloads,
        requestCursor,
        requestsAfter,
        runNodeScenarioDir,
        testRunEvents,
        testRunId,
      }) => {
        const cursor = requestCursor();

        await runNodeScenarioDir({
          scenarioDir,
          timeoutMs: TIMEOUT_MS,
        });

        const capturedEvents = testRunEvents();
        const basicSpan = findLatestSpan(capturedEvents, "jest basic span");
        const jsonAttachment = findEventByCase(
          capturedEvents,
          "json-attachment",
        );
        const parentSpan = findLatestSpan(capturedEvents, "jest parent span");
        const childSpan = findLatestSpan(capturedEvents, "jest child span");
        const nestedParent = findLatestSpan(
          capturedEvents,
          "jest nested parent span",
        );
        const nestedChild = findLatestSpan(
          capturedEvents,
          "jest nested child span",
        );
        const nestedGrandchild = findLatestSpan(
          capturedEvents,
          "jest nested grandchild span",
        );
        const currentSpan = findLatestSpan(capturedEvents, "jest current span");

        for (const span of [
          basicSpan,
          jsonAttachment,
          parentSpan,
          childSpan,
          nestedParent,
          nestedChild,
          nestedGrandchild,
          currentSpan,
        ]) {
          expect(span).toBeDefined();
        }

        expect(basicSpan?.input).toBe("What is the capital of France?");
        expect(basicSpan?.output).toBe("Paris");
        expect(basicSpan?.expected).toBe("Paris");
        expect(basicSpan?.row.metadata).toMatchObject({
          case: "basic-span",
          scenario: "test-framework-evals-jest",
          testRunId,
          transport: "http",
        });

        expect(jsonAttachment?.input).toMatchObject({
          type: "chat_completion",
        });
        expect(jsonAttachment?.row.metadata).toMatchObject({
          case: "json-attachment",
          scenario: "test-framework-evals-jest",
          testRunId,
        });
        expect(jsonAttachment?.output).toMatchObject({
          attachment: true,
        });

        expect(parentSpan?.output).toMatchObject({
          phase: "parent",
          ok: true,
        });
        expect(childSpan?.span.parentIds).toEqual([parentSpan?.span.id ?? ""]);
        expect(childSpan?.output).toMatchObject({
          phase: "child",
          ok: true,
        });

        expect(nestedChild?.span.parentIds).toEqual([
          nestedParent?.span.id ?? "",
        ]);
        expect(nestedGrandchild?.span.parentIds).toEqual([
          nestedChild?.span.id ?? "",
        ]);
        expect(nestedGrandchild?.output).toMatchObject({
          depth: 3,
        });

        expect(currentSpan?.output).toMatchObject({
          observedSpanId: currentSpan?.span.id,
        });

        const requests = requestsAfter(
          cursor,
          (request) =>
            request.path === "/api/apikey/login" ||
            request.path === "/api/project/register" ||
            request.path === "/logs3",
        );

        expect(requests.map((request) => request.path)).toEqual(
          expect.arrayContaining([
            "/api/apikey/login",
            "/api/project/register",
            "/logs3",
          ]),
        );

        await expect(
          formatJsonFileSnapshot(
            [
              basicSpan,
              jsonAttachment,
              parentSpan,
              childSpan,
              nestedParent,
              nestedChild,
              nestedGrandchild,
              currentSpan,
            ].map((event) => summarizeEvent(event!)) as Json,
          ),
        ).toMatchFileSnapshot(
          resolveFileSnapshotPath(import.meta.url, "span-events.json"),
        );

        await expect(
          formatJsonFileSnapshot(
            payloadRowsForTestRunId(payloads(), testRunId) as Json,
          ),
        ).toMatchFileSnapshot(
          resolveFileSnapshotPath(import.meta.url, "log-payloads.json"),
        );

        await expect(
          formatJsonFileSnapshot(
            requests.map((request) =>
              summarizeRequest(request, {
                normalizeJsonRawBody: true,
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
