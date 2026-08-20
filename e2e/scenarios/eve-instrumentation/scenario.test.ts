import { beforeAll, describe, expect, test } from "vitest";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";
import type {
  CapturedLogEvent,
  CapturedLogPayload,
} from "../../helpers/mock-braintrust-server";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
  withScenarioHarness,
} from "../../helpers/scenario-harness";
import { matchSpanTreeSnapshot } from "../../helpers/span-tree";
import {
  findAllSpans,
  findChildSpans,
  findLatestChildSpan,
  spanInstrumentationName,
} from "../../helpers/trace-selectors";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});
const eveScenarios = await Promise.all(
  [
    {
      dependencyName: "eve-v0",
      label: "v0.34 pinned",
      variantKey: "eve-v0",
    },
    {
      dependencyName: "eve-v0-latest",
      label: "v0 latest",
      variantKey: "eve-v0-latest",
    },
  ].map(async (scenario) => ({
    ...scenario,
    version: await readInstalledPackageVersion(
      scenarioDir,
      scenario.dependencyName,
    ),
  })),
);
const TIMEOUT_MS = 120_000;

describe.sequential("eve instrumentation variants", () => {
  for (const scenario of eveScenarios) {
    describe(`${scenario.label} (${scenario.version})`, () => {
      let events: CapturedLogEvent[] = [];
      let payloads: CapturedLogPayload[] = [];

      beforeAll(async () => {
        await withScenarioHarness(
          async ({
            events: harnessEvents,
            payloads: harnessPayloads,
            runScenarioDir,
          }) => {
            await runScenarioDir({
              entry: "scenario.ts",
              env: {
                EVE_PACKAGE_NAME: scenario.dependencyName,
                NODE_ENV: "development",
              },
              runContext: {
                originalScenarioDir,
                variantKey: scenario.variantKey,
              },
              scenarioDir,
              timeoutMs: TIMEOUT_MS,
            });
            events = harnessEvents();
            payloads = harnessPayloads();
          },
        );
      }, TIMEOUT_MS);

      test("captures user turns as traces with subagent turns attached", async () => {
        const turns = findAllSpans(events, "eve.turn");
        const root = turns.find(
          (turn) =>
            Array.isArray(turn.input) &&
            turn.input[0]?.content ===
              "Run the Braintrust Eve instrumentation e2e scenario",
        );
        const secondRoot = turns.find(
          (turn) =>
            Array.isArray(turn.input) &&
            turn.input[0]?.content ===
              "Run the Braintrust Eve instrumentation e2e scenario again",
        );
        const steps = findChildSpans(events, "eve.step", root?.span.id);
        const researcher = findChildSpans(
          events,
          "researcher",
          root?.span.id,
        )[0];
        const childTurn = turns.find(
          (turn) =>
            Array.isArray(turn.input) &&
            String(turn.input[0]?.content).includes(
              "Caller message:\nRun the Braintrust Eve instrumentation e2e scenario",
            ) &&
            !String(turn.input[0]?.content).includes("scenario again"),
        );
        const childSteps = findChildSpans(
          events,
          "eve.step",
          childTurn?.span.id,
        );
        const childSearch = findLatestChildSpan(
          events,
          "search",
          childTurn?.span.id,
        );
        const read = findLatestChildSpan(events, "read", root?.span.id);
        const secondSteps = findChildSpans(
          events,
          "eve.step",
          secondRoot?.span.id,
        );
        const secondResearcher = findLatestChildSpan(
          events,
          "researcher",
          secondRoot?.span.id,
        );
        const secondChildTurn = turns.find(
          (turn) =>
            Array.isArray(turn.input) &&
            String(turn.input[0]?.content).includes(
              "Caller message:\nRun the Braintrust Eve instrumentation e2e scenario again",
            ),
        );
        const secondRead = findLatestChildSpan(
          events,
          "read",
          secondRoot?.span.id,
        );
        const secondChildSearch = findLatestChildSpan(
          events,
          "search",
          secondChildTurn?.span.id,
        );
        expect(findAllSpans(events, "eve.session")).toEqual([]);
        expect(turns).toHaveLength(4);
        expect(
          turns.filter((turn) => turn.span.parentIds.length === 0),
        ).toEqual([root, secondRoot]);
        expect(new Set(turns.map((turn) => turn.span.rootId)).size).toBe(2);

        expect(root).toBeDefined();
        expect(root?.span.type).toBe("task");
        expect(root?.span.parentIds).toEqual([]);
        expect(root?.metadata).toMatchObject({
          "eve.session_id": expect.any(String),
          scenario: "eve-instrumentation",
          testRunId: expect.any(String),
        });
        expect(root?.metadata).not.toHaveProperty("model");
        expect(root?.metadata).not.toHaveProperty("provider");
        expect(root?.output).toContain("Final answer from read");
        expect(root?.metrics).toMatchObject({
          completion_tokens: steps.reduce(
            (total, step) => total + (step.metrics?.completion_tokens ?? 0),
            0,
          ),
          prompt_tokens: steps.reduce(
            (total, step) => total + (step.metrics?.prompt_tokens ?? 0),
            0,
          ),
          tokens: steps.reduce(
            (total, step) => total + (step.metrics?.tokens ?? 0),
            0,
          ),
        });

        expect(steps).toHaveLength(2);
        expect(steps.map((step) => step.span.type)).toEqual(["llm", "llm"]);
        expect(steps[0]?.output).toMatchObject([
          {
            finish_reason: "tool_calls",
            message: {
              reasoning: [{ content: expect.any(String) }],
              tool_calls: [
                { function: { name: "researcher" }, type: "function" },
                { function: { name: "read" }, type: "function" },
              ],
            },
          },
        ]);
        expect(steps[1]?.output).toMatchObject([
          {
            finish_reason: "stop",
            message: {
              reasoning: [{ content: expect.any(String) }],
            },
          },
        ]);
        for (const step of steps) {
          expect(step.span.parentIds).toEqual([root?.span.id]);
          expect(Array.isArray(step.input)).toBe(true);
          if (!Array.isArray(step.input)) {
            throw new Error("Expected Eve step input to be a message array");
          }
          expect(step.input[0]).toMatchObject({ role: "system" });
          expect(step.metadata).toMatchObject({
            "eve.session_id": root?.metadata?.["eve.session_id"],
            model: "qwen/qwen3-30b-a3b",
            provider: "openrouter",
            scenario: "eve-instrumentation",
            testRunId: expect.any(String),
          });
          expect(step.metrics?.completion_tokens).toEqual(expect.any(Number));
          expect(step.metrics?.prompt_tokens).toEqual(expect.any(Number));
          expect(step.metrics?.tokens).toEqual(expect.any(Number));
        }

        expect(researcher).toBeDefined();
        expect(researcher?.span.type).toBe("tool");
        expect(researcher?.span.ended).toBe(true);
        expect(researcher?.span.parentIds).toEqual([root?.span.id]);
        expect(researcher?.input).toMatchObject({
          message: expect.stringContaining("Braintrust Eve instrumentation"),
        });
        expect(researcher?.metadata).toMatchObject({
          "eve.session_id": root?.metadata?.["eve.session_id"],
          scenario: "eve-instrumentation",
          testRunId: expect.any(String),
        });
        expect(researcher?.output).toContain("Researcher result");

        expect(childTurn).toBeDefined();
        expect(childTurn?.span.parentIds).toEqual([researcher?.span.id]);
        expect(childTurn?.span.rootId).toEqual(root?.span.rootId);
        expect(childTurn?.metadata).toMatchObject({
          "eve.session_id": expect.any(String),
          scenario: "eve-instrumentation",
          testRunId: expect.any(String),
        });
        expect(childTurn?.metadata).not.toHaveProperty("model");
        expect(childTurn?.metadata).not.toHaveProperty("provider");
        expect(childTurn?.metadata?.["eve.session_id"]).not.toEqual(
          root?.metadata?.["eve.session_id"],
        );
        expect(childTurn?.metrics).toMatchObject({
          completion_tokens: childSteps.reduce(
            (total, step) => total + (step.metrics?.completion_tokens ?? 0),
            0,
          ),
          prompt_tokens: childSteps.reduce(
            (total, step) => total + (step.metrics?.prompt_tokens ?? 0),
            0,
          ),
          tokens: childSteps.reduce(
            (total, step) => total + (step.metrics?.tokens ?? 0),
            0,
          ),
        });

        expect(childSteps).toHaveLength(2);
        for (const step of childSteps) {
          expect(step.span.type).toBe("llm");
          expect(step.span.parentIds).toEqual([childTurn?.span.id]);
          expect(Array.isArray(step.input)).toBe(true);
          if (!Array.isArray(step.input)) {
            throw new Error("Expected Eve step input to be a message array");
          }
          expect(step.input[0]).toMatchObject({ role: "system" });
          expect(step.metadata).toMatchObject({
            "eve.session_id": childTurn?.metadata?.["eve.session_id"],
            model: "qwen/qwen3-30b-a3b",
            provider: "openrouter",
            scenario: "eve-instrumentation",
            testRunId: expect.any(String),
          });
          expect(step.metrics?.completion_tokens).toEqual(expect.any(Number));
          expect(step.metrics?.prompt_tokens).toEqual(expect.any(Number));
          expect(step.metrics?.tokens).toEqual(expect.any(Number));
          expect(step.output).toMatchObject([
            {
              message: {
                reasoning: [{ content: expect.any(String) }],
              },
            },
          ]);
        }

        expect(childSearch).toBeDefined();
        expect(childSearch?.span.type).toBe("tool");
        expect(childSearch?.span.ended).toBe(true);
        expect(childSearch?.span.parentIds).toEqual([childTurn?.span.id]);
        expect(childSearch?.metadata).toMatchObject({
          "eve.session_id": childTurn?.metadata?.["eve.session_id"],
        });
        expect(childSearch?.input).toMatchObject({
          query: expect.stringContaining("Braintrust Eve instrumentation"),
        });
        expect(childSearch?.output).toMatchObject({
          title: "Eve instrumentation",
        });

        expect(read).toBeDefined();
        expect(read?.span.type).toBe("tool");
        expect(read?.span.ended).toBe(true);
        expect(read?.span.parentIds).toEqual([root?.span.id]);
        expect(read?.metadata).toMatchObject({
          "eve.session_id": root?.metadata?.["eve.session_id"],
        });
        expect(read?.input).toMatchObject({
          url: "https://eve.dev/docs/guides/instrumentation",
        });
        expect(read?.output).toMatchObject({
          section: "Runtime context",
          title: "Eve instrumentation",
        });

        expect(secondRoot).toBeDefined();
        expect(secondRoot?.span.type).toBe("task");
        expect(secondRoot?.span.parentIds).toEqual([]);
        expect(secondRoot?.span.rootId).not.toEqual(root?.span.rootId);
        expect(secondRoot?.metadata).toMatchObject({
          "eve.session_id": root?.metadata?.["eve.session_id"],
          scenario: "eve-instrumentation",
          testRunId: expect.any(String),
        });
        expect(secondRoot?.output).toContain("Final answer from read");
        expect(secondRoot?.metrics).toMatchObject({
          completion_tokens: secondSteps.reduce(
            (total, step) => total + (step.metrics?.completion_tokens ?? 0),
            0,
          ),
          prompt_tokens: secondSteps.reduce(
            (total, step) => total + (step.metrics?.prompt_tokens ?? 0),
            0,
          ),
          tokens: secondSteps.reduce(
            (total, step) => total + (step.metrics?.tokens ?? 0),
            0,
          ),
        });
        expect(secondSteps).toHaveLength(2);
        for (const step of secondSteps) {
          expect(step.span.parentIds).toEqual([secondRoot?.span.id]);
          expect(step.span.rootId).toEqual(secondRoot?.span.rootId);
          expect(step.metadata).toMatchObject({
            "eve.session_id": secondRoot?.metadata?.["eve.session_id"],
            model: "qwen/qwen3-30b-a3b",
            provider: "openrouter",
          });
        }
        expect(secondResearcher?.span.parentIds).toEqual([secondRoot?.span.id]);
        expect(secondChildTurn?.span.parentIds).toEqual([
          secondResearcher?.span.id,
        ]);
        expect(secondChildTurn?.span.rootId).toEqual(secondRoot?.span.rootId);
        expect(secondChildTurn?.span.rootId).not.toEqual(root?.span.rootId);
        expect(secondRead?.span.parentIds).toEqual([secondRoot?.span.id]);

        for (const event of events) {
          expect(spanInstrumentationName(event)).toBe("eve");
        }

        const rawRows = payloads.flatMap((payload) => payload.rows);
        for (const span of [
          ...findAllSpans(events, "eve.step"),
          researcher,
          childSearch,
          read,
          secondResearcher,
          secondRead,
          secondChildSearch,
        ]) {
          expect(span).toBeDefined();
          expect(
            rawRows.filter(
              (row) =>
                row.id === span?.row.id &&
                Object.prototype.hasOwnProperty.call(row, "input"),
            ),
          ).toHaveLength(1);
          expect(
            rawRows.filter(
              (row) =>
                row.id === span?.row.id &&
                Object.prototype.hasOwnProperty.call(row, "metadata"),
            ),
          ).toHaveLength(1);
        }
        for (const turn of turns) {
          expect(
            rawRows.filter(
              (row) =>
                row.id === turn.row.id &&
                Object.prototype.hasOwnProperty.call(row, "metadata"),
            ),
          ).toHaveLength(1);
        }
        for (const step of findAllSpans(events, "eve.step")) {
          expect(
            rawRows.filter(
              (row) =>
                row.id === step.row.id &&
                Object.prototype.hasOwnProperty.call(row, "output"),
            ),
          ).toHaveLength(1);
        }

        await matchSpanTreeSnapshot(
          events,
          resolveFileSnapshotPath(
            import.meta.url,
            `${scenario.variantKey}.span-tree.json`,
          ),
          {
            normalize: {
              additionalProviderIdKeys: ["eve.session_id"],
            },
          },
        );
      });
    });
  }
});
