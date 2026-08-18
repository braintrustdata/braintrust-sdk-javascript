import * as fs from "fs/promises";
import * as path from "path";
import { tmpdir } from "os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RemoteEvalParameters } from "../logger";
import { configureNode } from "../node/config";
import { DiskCache } from "./disk-cache";
import {
  ParametersCache,
  type ParametersDiskCacheEntry,
} from "./parameters-cache";

describe("ParametersCache", () => {
  configureNode();

  let cacheDir: string;

  beforeEach(() => {
    cacheDir = path.join(
      tmpdir(),
      `parameters-cache-test-${Date.now()}-${Math.random()}`,
    );
  });

  afterEach(async () => {
    await fs.rm(cacheDir, { recursive: true, force: true });
  });

  it("reconstructs parameters loaded from disk", async () => {
    const key = {
      projectId: "55555555-5555-4555-8555-555555555555",
      slug: "saved-parameters",
      version: "v1",
    };
    const parameters = new RemoteEvalParameters({
      id: "44444444-4444-4444-8444-444444444444",
      _xact_id: "v1",
      project_id: key.projectId,
      name: "Saved parameters",
      slug: key.slug,
      description: null,
      function_type: "parameters",
      function_data: {
        type: "parameters",
        data: { prefix: "hello" },
        __schema: {
          type: "object",
          properties: { prefix: { type: "string" } },
          required: ["prefix"],
        },
      },
    });
    const diskCache = new DiskCache<ParametersDiskCacheEntry>({
      cacheDir,
      logWarnings: false,
    });

    await new ParametersCache({ diskCache }).set(key, parameters);
    const result = await new ParametersCache({ diskCache }).get(key);

    expect(result).toBeInstanceOf(RemoteEvalParameters);
    expect(result?.data).toEqual({ prefix: "hello" });
    expect(result?.schema).toEqual({
      type: "object",
      properties: { prefix: { type: "string" } },
      required: ["prefix"],
    });
  });
});
