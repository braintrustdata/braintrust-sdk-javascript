import { expect, test } from "vitest";
import { normalizeForSnapshot, type Json } from "../../helpers/normalize";
import {
  prepareScenarioDir,
  resolveScenarioDir,
  withScenarioHarness,
} from "../../helpers/scenario-harness";
import { summarizeRequest } from "../../helpers/trace-summary";

const scenarioDir = await prepareScenarioDir({
  scenarioDir: resolveScenarioDir(import.meta.url),
});

function parseScenarioSummary(stdout: string): Json {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const lastLine = lines.at(-1);
  if (!lastLine) {
    throw new Error("Scenario did not emit a JSON summary");
  }

  return JSON.parse(lastLine) as Json;
}

type ScenarioExecutions = {
  chatPrompt: {
    api: string;
    finishReason: string | null;
    hasContent: boolean;
  };
  completionPrompt: {
    api: string;
    hasOutputText: boolean;
    outputItemTypes: string[];
    status: string | null;
  };
  responsesPrompt: {
    api: string;
    hasOutputText: boolean;
    outputItemTypes: string[];
    status: string | null;
  };
};

type ScenarioSummary = {
  builds: Json;
  executions: ScenarioExecutions;
};

test("prompt-flavors-prod loads production prompts and builds each flavor", async () => {
  await withScenarioHarness(
    async ({ requestCursor, requestsAfter, runScenarioDir }) => {
      const cursor = requestCursor();
      const result = await runScenarioDir({
        scenarioDir,
        timeoutMs: 180_000,
      });
      const summary = parseScenarioSummary(result.stdout) as ScenarioSummary;

      expect(normalizeForSnapshot(summary.builds)).toMatchSnapshot(
        "prompt-builds",
      );

      expect(summary.executions.chatPrompt.api).toBe("chat.completions.create");
      expect(summary.executions.chatPrompt.hasContent).toBe(true);
      expect(summary.executions.responsesPrompt.api).toBe("responses.create");
      expect(summary.executions.responsesPrompt.hasOutputText).toBe(true);
      expect(summary.executions.responsesPrompt.outputItemTypes).toEqual(
        expect.arrayContaining(["message"]),
      );
      expect(["completed", "incomplete"]).toContain(
        summary.executions.responsesPrompt.status,
      );
      expect(summary.executions.completionPrompt.api).toBe("responses.create");
      expect(summary.executions.completionPrompt.hasOutputText).toBe(true);
      expect(summary.executions.completionPrompt.outputItemTypes).toEqual(
        expect.arrayContaining(["message"]),
      );
      expect(["completed", "incomplete"]).toContain(
        summary.executions.completionPrompt.status,
      );

      const requests = requestsAfter(
        cursor,
        (request) =>
          request.path === "/api/apikey/login" ||
          request.path === "/api/project/register" ||
          request.path === "/insert-functions" ||
          request.path === "/v1/prompt" ||
          request.path.startsWith("/v1/prompt/"),
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
