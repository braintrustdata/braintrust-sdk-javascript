import { describe, expect, test, vi } from "vitest";
import { buildBundledFunctionEntry } from "./upload";
import { findCodeDefinition } from "./infer-source";

vi.mock("./infer-source", () => ({
  findCodeDefinition: vi.fn(),
  makeSourceMapContext: vi.fn(),
}));

describe("buildBundledFunctionEntry", () => {
  test("preserves tags and existing function fields", async () => {
    const spec = {
      project_id: "proj-123",
      name: "test-tool",
      slug: "test-tool",
      description: "Test tool",
      location: {
        type: "function" as const,
        index: 0,
      },
      function_type: "tool" as const,
      origin: {
        object_type: "experiment" as const,
        object_id: "exp-123",
        internal: false,
      },
      function_schema: {
        parameters: { type: "object" },
        returns: { type: "string" },
      },
      if_exists: "replace" as const,
      tags: ["ci", "sdk"],
      metadata: { owner: "sdk" },
    };

    const entry = await buildBundledFunctionEntry({
      spec,
      runtime_context: { runtime: "node", version: "22.0.0" },
      bundleId: "bundle-123",
      sourceMapContext: undefined,
    });

    expect(entry).toMatchObject({
      project_id: "proj-123",
      name: "test-tool",
      slug: "test-tool",
      description: "Test tool",
      origin: spec.origin,
      function_type: "tool",
      function_schema: spec.function_schema,
      if_exists: "replace",
      tags: ["ci", "sdk"],
      metadata: { owner: "sdk" },
      function_data: {
        type: "code",
        data: {
          type: "bundle",
          runtime_context: { runtime: "node", version: "22.0.0" },
          location: spec.location,
          bundle_id: "bundle-123",
        },
      },
    });
    expect(entry.function_data.data.preview).toBeUndefined();
  });

  test("does not invent tags when they are omitted", async () => {
    const entry = await buildBundledFunctionEntry({
      spec: {
        project_id: "proj-123",
        name: "test-tool",
        slug: "test-tool",
        description: "Test tool",
        location: {
          type: "function" as const,
          index: 0,
        },
        function_type: "tool" as const,
      },
      runtime_context: { runtime: "node", version: "22.0.0" },
      bundleId: "bundle-123",
      sourceMapContext: undefined,
    });

    expect(entry.tags).toBeUndefined();
  });

  test("preserves classifier experiment locations", async () => {
    const entry = await buildBundledFunctionEntry({
      spec: {
        project_id: "proj-123",
        name: "test-classifier",
        slug: "test-classifier",
        description: "Test classifier",
        location: {
          type: "experiment" as const,
          eval_name: "eval-1",
          position: {
            type: "classifier" as const,
            index: 0,
          },
        },
        function_type: "classifier" as const,
      },
      runtime_context: { runtime: "node", version: "22.0.0" },
      bundleId: "bundle-123",
      sourceMapContext: undefined,
    });

    expect(entry.function_type).toBe("classifier");
    expect(entry.function_data.data.location).toEqual({
      type: "experiment",
      eval_name: "eval-1",
      position: {
        type: "classifier",
        index: 0,
      },
    });
  });
});
