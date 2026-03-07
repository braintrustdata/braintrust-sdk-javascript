/**
 * Tests for zod v3 compatibility with serializeEvalParametersToStaticParametersSchema
 *
 * This file tests serializeEvalParametersToStaticParametersSchema specifically with zod v3.
 * See zod-v4-serialization.test.ts for zod v4 specific tests.
 */

import { test, describe, beforeEach, expect } from "vitest";
import * as zodModule from "zod";
import { z } from "zod";
import {
  EXPECTED_STRING_SCHEMA,
  EXPECTED_NUMBER_SCHEMA,
  EXPECTED_OBJECT_SCHEMA,
  EXPECTED_ENUM_SCHEMA,
  EXPECTED_ARRAY_SCHEMA,
} from "./zod-serialization-test-shared";
import {
  serializeEvalParametersToStaticParametersSchema,
  serializeRemoteEvalParametersContainer,
} from "../framework2";
// Detect which zod version is installed by checking for v4-specific properties
function getInstalledZodVersion(): 3 | 4 {
  const testSchema = zodModule.z.string();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return "_zod" in (testSchema as any) ? 4 : 3;
}

describe("serializeEvalParametersToStaticParametersSchema with Zod v3", () => {
  beforeEach(() => {
    const version = getInstalledZodVersion();
    expect(version).toBe(3);
  });

  test("string schema serializes correctly", () => {
    const parameters = {
      instructions: z
        .string()
        .describe("The instructions for the agent")
        .default("You are a helpful assistant."),
    };

    const result = serializeEvalParametersToStaticParametersSchema(parameters);
    console.log(result);
    expect(result.instructions).toBeDefined();
    expect(result.instructions.type).toBe("data");
    expect(
      result.instructions.type === "data" && result.instructions.schema,
    ).toStrictEqual(EXPECTED_STRING_SCHEMA);
    expect(result.instructions.description).toBe(
      "The instructions for the agent",
    );
    expect(result.instructions.default).toBe("You are a helpful assistant.");
  });

  test("number schema serializes correctly", () => {
    const parameters = {
      temperature: z
        .number()
        .min(0)
        .max(2)
        .describe("Temperature for LLM")
        .default(0.7),
    };

    const result = serializeEvalParametersToStaticParametersSchema(parameters);

    result.temperature.type;

    expect(result.temperature.type).toBe("data");
    expect(
      result.temperature.type === "data" && result.temperature.schema,
    ).toStrictEqual(EXPECTED_NUMBER_SCHEMA);
    expect(result.temperature.description).toBe("Temperature for LLM");
    expect(result.temperature.default).toBe(0.7);
  });

  test("object schema serializes correctly", () => {
    const parameters = {
      config: z
        .object({
          model: z.string(),
          maxTokens: z.number().optional(),
        })
        .describe("Configuration object"),
    };

    const result = serializeEvalParametersToStaticParametersSchema(parameters);

    expect(result.config.type).toBe("data");
    expect(result.config.type === "data" && result.config.schema).toStrictEqual(
      EXPECTED_OBJECT_SCHEMA,
    );
    expect(result.config.description).toBe("Configuration object");
  });

  test("enum schema serializes correctly", () => {
    const parameters = {
      mode: z
        .enum(["fast", "accurate", "balanced"])
        .describe("Processing mode")
        .default("balanced"),
    };

    const result = serializeEvalParametersToStaticParametersSchema(parameters);

    expect(result.mode.type).toBe("data");
    expect(result.mode.type === "data" && result.mode.schema).toStrictEqual(
      EXPECTED_ENUM_SCHEMA,
    );
    expect(result.mode.description).toBe("Processing mode");
    expect(result.mode.default).toBe("balanced");
  });

  test("array schema serializes correctly", () => {
    const parameters = {
      tags: z
        .array(z.string())
        .describe("Tags for filtering")
        .default(["default"]),
    };

    const result = serializeEvalParametersToStaticParametersSchema(parameters);

    expect(result.tags.type).toBe("data");
    expect(result.tags.type === "data" && result.tags.schema).toStrictEqual(
      EXPECTED_ARRAY_SCHEMA,
    );
    expect(result.tags.description).toBe("Tags for filtering");
    expect(result.tags.default).toEqual(["default"]);
  });

  test("model parameter serializes correctly", () => {
    const parameters = {
      model: {
        type: "model" as const,
        description: "Model to use",
        default: "gpt-5-mini",
      },
    };

    const result = serializeEvalParametersToStaticParametersSchema(parameters);

    expect(result.model.type).toBe("model");
    expect(result.model.description).toBe("Model to use");
    expect(result.model.default).toBe("gpt-5-mini");
  });
});

describe("serializeRemoteEvalParametersContainer with Zod v3", () => {
  beforeEach(() => {
    const version = getInstalledZodVersion();
    expect(version).toBe(3);
  });

  test("local parameters are serialized with legacyParameters type", () => {
    const parameters = {
      instructions: z
        .string()
        .describe("The instructions for the agent")
        .default("You are a helpful assistant."),
    };

    const result = serializeRemoteEvalParametersContainer(parameters);

    expect(result.type).toBe("braintrust.staticParameters");
    expect(result.source).toBeNull();
    if (result.type === "braintrust.staticParameters") {
      expect(result.schema.instructions).toBeDefined();
      expect(result.schema.instructions.type).toBe("data");
    }
  });
});
