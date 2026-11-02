import { beforeAll, describe, expect, test } from "vite-plus/test";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";
import {
  withScenarioHarness,
  type ScenarioRunContext,
} from "../../helpers/scenario-harness";
import { matchSpanTreeSnapshot } from "../../helpers/span-tree";
import {
  findLatestChildSpan,
  findLatestSpan,
} from "../../helpers/trace-selectors";
import { ROOT_NAME, SCENARIO_NAME } from "./scenario.impl.mjs";

type RunTypeSafeScenario = (harness: {
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

function spanTreeEvents(
  events: CapturedLogEvent[],
  supportsImages: boolean,
): CapturedLogEvent[] {
  const operations = [
    "typesafe-mixed-operation",
    "typesafe-raw-operation",
    ...(supportsImages
      ? [
          "typesafe-image-operation",
          "typesafe-template-operation",
          "typesafe-box-operation",
        ]
      : []),
  ];
  return [
    findLatestSpan(events, ROOT_NAME),
    ...operations.flatMap((operationName) => {
      const operation = findLatestSpan(events, operationName);
      return [
        operation,
        findLatestChildSpan(events, "typesafe.systemOne", operation?.span.id),
      ];
    }),
  ].map((event) => event!);
}

export function defineTypeSafeInstrumentationAssertions(options: {
  name: string;
  runScenario: RunTypeSafeScenario;
  snapshotName: string;
  supportsImages: boolean;
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

    test("captures native questions and every structured answer", () => {
      const root = findLatestSpan(events, ROOT_NAME);
      const operation = findLatestSpan(events, "typesafe-mixed-operation");
      const span = findLatestChildSpan(
        events,
        "typesafe.systemOne",
        operation?.span.id,
      );

      expect(root?.row.metadata).toMatchObject({ scenario: SCENARIO_NAME });
      expect(span?.span.type).toBe("decision");
      expect(span?.input).toMatchObject({
        state: { message: expect.any(String) },
        questions: expect.arrayContaining([
          expect.objectContaining({ id: "category", type: "choice" }),
          expect.objectContaining({ id: "urgency", type: "score" }),
          expect.objectContaining({ id: "duplicate_charge", type: "noul" }),
        ]),
      });
      expect(span?.output).toMatchObject({
        answers: expect.arrayContaining([
          expect.objectContaining({
            id: "category",
            type: "choice",
            choice: expect.any(String),
            confidence: expect.any(Number),
            probabilities: expect.any(Object),
          }),
          expect.objectContaining({
            id: "urgency",
            type: "score",
            score: expect.any(Number),
            confidence: expect.any(Number),
            legend: expect.any(Object),
            probabilities: expect.any(Object),
          }),
          expect.objectContaining({
            id: "duplicate_charge",
            type: "noul",
            noul: expect.any(Number),
          }),
        ]),
      });
      expect(span?.row.metadata).toMatchObject({
        model: expect.stringMatching(/^jev-/),
        provider: "typesafe",
      });
      expect(span?.metrics).toMatchObject({
        completion_tokens: expect.any(Number),
        prompt_tokens: expect.any(Number),
        tokens: expect.any(Number),
      });
    });

    test("captures output while preserving raw response access", () => {
      const operation = findLatestSpan(events, "typesafe-raw-operation");
      const span = findLatestChildSpan(
        events,
        "typesafe.systemOne",
        operation?.span.id,
      );

      expect(span?.input).toMatchObject({
        state: "The package arrived intact and on time.",
        questions: [{ id: "positive", type: "noul" }],
      });
      expect(span?.output).toMatchObject({
        answers: [{ id: "positive", type: "noul", noul: expect.any(Number) }],
      });
      expect(span?.row.metadata).toMatchObject({
        model: "jev-1.13.0",
        provider: "typesafe",
      });
    });

    if (options.supportsImages) {
      test("preserves image references without capturing bytes by default", () => {
        const operation = findLatestSpan(events, "typesafe-image-operation");
        const span = findLatestChildSpan(
          events,
          "typesafe.systemOne",
          operation?.span.id,
        );
        expect(span?.input).toMatchObject({ state: { type: "image" } });
        expect(span?.input).not.toHaveProperty("assets");
        expect(span?.output).toMatchObject({
          answers: [{ id: "ship", type: "noul", noul: expect.any(Number) }],
        });
      });

      test("captures template images in place in state, instructions and criteria", () => {
        const operation = findLatestSpan(events, "typesafe-template-operation");
        const span = findLatestChildSpan(
          events,
          "typesafe.systemOne",
          operation?.span.id,
        );
        const reference = {
          type: "braintrust_attachment",
          content_type: "image/png",
        };
        expect(span?.input).toMatchObject({
          state: { scene: ["Look at ", reference, "."] },
          questions: [
            {
              id: "weather",
              instructions: ["What weather is shown in ", reference, "?"],
              criteria: { stormy: ["Stormy weather in ", reference] },
            },
          ],
        });
        expect(span?.input).not.toHaveProperty("assets");
        expect(span?.output).toMatchObject({
          answers: [
            { id: "weather", type: "choice", choice: expect.any(String) },
          ],
        });
      });

      test("captures mixed answers and associates multiple boxes with the nested image", () => {
        const operation = findLatestSpan(events, "typesafe-box-operation");
        const span = findLatestChildSpan(
          events,
          "typesafe.systemOne",
          operation?.span.id,
        );
        expect(span?.span.type).toBe("decision");
        expect(span?.input).toMatchObject({
          state: {
            "photos~/": [
              { type: "braintrust_attachment", content_type: "image/png" },
            ],
            description: "Locate the ship.",
          },
          questions: expect.arrayContaining([
            { id: "ship", type: "box", instructions: "The sailing ship" },
            {
              id: "mast",
              type: "box",
              instructions: "The tallest mast on the ship",
            },
            expect.objectContaining({ id: "present", type: "noul" }),
            expect.objectContaining({ id: "weather", type: "choice" }),
            expect.objectContaining({ id: "waves", type: "score" }),
          ]),
        });
        expect(span?.output).toMatchObject({
          answers: expect.arrayContaining([
            ...["ship", "mast"].map((id) => ({
              id,
              type: "box",
              image_path: "/state/photos~0~1/0",
              box: {
                top: expect.any(Number),
                bottom: expect.any(Number),
                left: expect.any(Number),
                right: expect.any(Number),
              },
              confidence: expect.toSatisfy(
                (value: unknown) => value === null || typeof value === "number",
              ),
            })),
            expect.objectContaining({
              id: "present",
              type: "noul",
              noul: expect.any(Number),
            }),
            expect.objectContaining({
              id: "weather",
              type: "choice",
              choice: expect.any(String),
            }),
            expect.objectContaining({
              id: "waves",
              type: "score",
              score: expect.any(Number),
            }),
          ]),
        });
        expect((span?.output as { answers: unknown[] }).answers).toHaveLength(
          5,
        );
        expect(span?.row).not.toHaveProperty("scores");
        expect(span?.row.metadata).toMatchObject({
          model: expect.stringMatching(/^jev-/),
          provider: "typesafe",
        });
        expect(span?.metrics).toMatchObject({
          prompt_tokens: expect.any(Number),
        });
      });
    }

    test("matches the span tree snapshot", async ({ expect }) => {
      await matchSpanTreeSnapshot(
        spanTreeEvents(events, options.supportsImages),
        spanSnapshotPath,
        { snapshotExpect: expect },
      );
    });
  });
}
