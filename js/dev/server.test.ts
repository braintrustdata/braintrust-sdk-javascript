import { describe, expect, test } from "vitest";
import { BraintrustState } from "../src/logger";
import { _exportsForTestingOnly } from "./server";
import { evalBodySchema } from "./types";

describe("remote eval data", () => {
  test("uses a named experiment as the data source", async () => {
    const request = evalBodySchema.parse({
      name: "remote-evaluator",
      data: { experiment_name: "source-experiment" },
    });
    const state = new BraintrustState({});

    await expect(
      _exportsForTestingOnly.getDataset(state, request.data),
    ).resolves.toEqual({
      _type: "BaseExperiment",
      name: "source-experiment",
    });
  });
});

describe("remote eval max concurrency", () => {
  test.each([
    { evaluator: 5, request: 2, expected: 2 },
    { evaluator: 5, request: 10, expected: 5 },
    { evaluator: undefined, request: 3, expected: 3 },
    { evaluator: 5, request: null, expected: 5 },
    { evaluator: 5, request: undefined, expected: 5 },
    { evaluator: undefined, request: undefined, expected: undefined },
  ])(
    "evaluator $evaluator with request $request resolves to $expected",
    ({ evaluator, request, expected }) => {
      expect(
        _exportsForTestingOnly.resolveMaxConcurrency(evaluator, request),
      ).toBe(expected);
    },
  );

  test("parses max_concurrency from the request body", () => {
    expect(
      evalBodySchema.parse({
        name: "remote-evaluator",
        data: { experiment_name: "source-experiment" },
        max_concurrency: 2,
      }).max_concurrency,
    ).toBe(2);
  });

  test("rounds down a fractional max_concurrency", () => {
    expect(
      evalBodySchema.parse({
        name: "remote-evaluator",
        data: { experiment_name: "source-experiment" },
        max_concurrency: 2.5,
      }).max_concurrency,
    ).toBe(2);
  });

  test.each([0, -1, 0.5, "2"])(
    "rejects invalid max_concurrency %s",
    (maxConcurrency) => {
      const result = evalBodySchema.safeParse({
        name: "remote-evaluator",
        data: { experiment_name: "source-experiment" },
        max_concurrency: maxConcurrency,
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((issue) => issue.path)).toEqual([
        ["max_concurrency"],
      ]);
    },
  );
});
