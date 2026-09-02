import { expect, test } from "vitest";

import { SpanComponentsV3, SpanObjectTypeV3 } from "../util";
import { BraintrustState, spanComponentsToObjectId } from "./logger";
import { configureNode } from "./node/config";

configureNode();

test("spanComponentsToObjectId resolves project_id metadata without a request", async () => {
  const state = new BraintrustState({
    apiKey: "test-api-key",
    appUrl: "http://localhost:1",
    fetch: async () => {
      throw new Error("unexpected request");
    },
  });
  const components = new SpanComponentsV3({
    object_type: SpanObjectTypeV3.PROJECT_LOGS,
    compute_object_metadata_args: { project_id: "project-id" },
  });

  await expect(spanComponentsToObjectId({ components, state })).resolves.toBe(
    "project-id",
  );
});
