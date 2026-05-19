import { expect, test } from "vitest";
import { normalizeForSnapshot, type Json } from "../../helpers/normalize";
import {
  prepareScenarioDir,
  resolveScenarioDir,
  withScenarioHarness,
} from "../../helpers/scenario-harness";
import { findLatestSpan } from "../../helpers/trace-selectors";
import { summarizeEvent, summarizeRequest } from "../../helpers/trace-summary";

const scenarioDir = await prepareScenarioDir({
  scenarioDir: resolveScenarioDir(import.meta.url),
});

test("trace-primitives-basic collects a minimal manual trace tree", async () => {
  await withScenarioHarness(
    async ({ requestCursor, requestsAfter, runScenarioDir, testRunEvents }) => {
      const cursor = requestCursor();

      await runScenarioDir({ scenarioDir });

      const capturedEvents = testRunEvents();
      const root = findLatestSpan(capturedEvents, "trace-primitives-root");
      const child = findLatestSpan(capturedEvents, "basic-child");
      const error = findLatestSpan(capturedEvents, "basic-error");

      expect(root).toBeDefined();
      expect(child).toBeDefined();
      expect(error).toBeDefined();

      expect(child?.span.parentIds).toEqual([root?.span.id ?? ""]);
      expect(error?.span.parentIds).toEqual([root?.span.id ?? ""]);
      expect(root?.span.rootId).toBe(root?.span.id);

      expect(
        normalizeForSnapshot(
          ["trace-primitives-root", "basic-child", "basic-error"].map((name) =>
            summarizeEvent(findLatestSpan(capturedEvents, name)!),
          ) as Json,
        ),
      ).toMatchSnapshot("span-events");

      const requests = requestsAfter(
        cursor,
        (request) =>
          request.path === "/api/apikey/login" ||
          request.path === "/api/project/register" ||
          request.path === "/version" ||
          request.path === "/logs3",
      );

      expect(
        normalizeForSnapshot(
          requests.map((request) =>
            summarizeRequest(request, {
              normalizeJsonRawBody: true,
            }),
          ) as Json,
        ),
      ).toMatchSnapshot("request-flow");
    },
  );
});
