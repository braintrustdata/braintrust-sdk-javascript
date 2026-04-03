import { describe, expect, test, vi } from "vitest";
import { type BraintrustState } from "../src/logger";
import { _exportsForTestingOnly } from "./server";

describe("run eval dataset selector helpers", () => {
  const state = {} as BraintrustState;

  test("maps project dataset refs into initDataset args", async () => {
    await expect(
      _exportsForTestingOnly.buildRunEvalDatasetInitArgs(state, {
        project_name: "test-project",
        dataset_name: "test-dataset",
        dataset_environment: "production",
        _internal_btql: { limit: 10 },
      }),
    ).resolves.toEqual({
      state,
      project: "test-project",
      dataset: "test-dataset",
      environment: "production",
      _internal_btql: { limit: 10 },
    });
  });

  test("maps dataset id refs into initDataset args", async () => {
    const lookupDatasetById = vi.fn().mockResolvedValue({
      projectId: "project-id-123",
      dataset: "resolved-dataset",
    });

    await expect(
      _exportsForTestingOnly.buildRunEvalDatasetInitArgs(
        state,
        {
          dataset_id: "dataset-id-123",
          dataset_snapshot_name: "release-candidate",
        },
        lookupDatasetById,
      ),
    ).resolves.toEqual({
      state,
      projectId: "project-id-123",
      dataset: "resolved-dataset",
      snapshotName: "release-candidate",
    });
    expect(lookupDatasetById).toHaveBeenCalledWith({
      state,
      datasetId: "dataset-id-123",
    });
  });

  test("rejects multiple dataset selectors", () => {
    expect(() =>
      _exportsForTestingOnly.getRunEvalDatasetSelector({
        project_name: "test-project",
        dataset_name: "test-dataset",
        dataset_version: "123",
        dataset_environment: "production",
      }),
    ).toThrow(
      "Cannot specify more than one of dataset_version, dataset_snapshot_name, and dataset_environment.",
    );
  });
});
