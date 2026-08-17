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
