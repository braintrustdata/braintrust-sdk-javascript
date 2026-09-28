import { beforeAll, expect, expectTypeOf, test } from "vitest";
import * as z3 from "zod/v3";
import * as z4 from "zod/v4";
import {
  CodeFunction,
  projects,
  serializeEvalParametersToStaticParametersSchema,
} from "./framework2";
import { configureNode } from "./node/config";
import { zodToJsonSchema } from "./zod/utils";

beforeAll(() => {
  configureNode();
});

test.each([
  {
    version: "v3",
    parameters: z3.object({ text: z3.string() }),
    returns: z3.number(),
  },
  {
    version: "v4",
    parameters: z4.object({ text: z4.string() }),
    returns: z4.number(),
  },
  {
    version: "mixed",
    parameters: z3.object({ text: z3.string() }),
    returns: z4.number(),
  },
])("code functions accept $version schemas", ({ parameters, returns }) => {
  const project = projects.create({ name: "test-zod-functions" });
  const fn = new CodeFunction(project, {
    name: "length",
    slug: "length",
    type: "tool",
    parameters,
    returns,
    handler: ({ text }) => {
      expectTypeOf(text).toEqualTypeOf<string>();
      return text.length;
    },
  });
  expectTypeOf(fn.parameters!.parse({ text: "hello" })).toEqualTypeOf<{
    text: string;
  }>();
  expectTypeOf(fn.returns!.parse(5)).toEqualTypeOf<number>();
  expect(fn.handler({ text: "hello" })).toBe(5);
  expect(zodToJsonSchema(fn.parameters!)).toMatchObject({
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  });
  expect(zodToJsonSchema(fn.returns!)).toMatchObject({ type: "number" });

  const tool = project.tools.create({
    name: "length-tool",
    parameters,
    returns,
    handler: ({ text }) => {
      expectTypeOf(text).toEqualTypeOf<string>();
      return text.length;
    },
  });
  expectTypeOf(tool.handler({ text: "hello" })).toEqualTypeOf<number>();
  expect(tool.handler({ text: "hello" })).toBe(5);
});

test("parameter builders serialize mixed Zod v3 and v4 schemas", () => {
  const project = projects.create({ name: "test-zod-parameters" });
  const schema = project.parameters.create({
    name: "mixed",
    schema: {
      prefix: z3.string().default("start:"),
      suffix: z4.string().default(":end"),
    },
  });
  expectTypeOf(schema.suffix).toEqualTypeOf<z4.ZodDefault<z4.ZodString>>();
  expect(serializeEvalParametersToStaticParametersSchema(schema)).toMatchObject(
    {
      prefix: { type: "data", schema: { type: "string" }, default: "start:" },
      suffix: { type: "data", schema: { type: "string" }, default: ":end" },
    },
  );
});
