import { expect, test } from "vite-plus/test";
import { objectNullish, parseNoStrip } from "./zod_util";
import { z } from "zod/v3";

const testSchema = z.object({
  a: z.string(),
  b: z.number().optional(),
});

test("parseNoStrip basic", () => {
  expect(parseNoStrip(testSchema, { a: "hello", b: 5 })).toEqual({
    a: "hello",
    b: 5,
  });
  expect(parseNoStrip(testSchema, { a: "hello" })).toEqual({ a: "hello" });
  expect(() => parseNoStrip(testSchema, { a: "hello", c: 5 })).toThrowError(
    /Extraneous key.*c.*at path.*/,
  );
});

test("objectNullish basic", () => {
  // Fill in unit tests.
  const schema = z.object({
    a: z.string(),
    b: z.string().nullish(),
    c: z.object({
      d: z.string(),
    }),
  });
  const nullishSchema = objectNullish(schema);

  const obj1 = {
    a: "a",
    b: "b",
    c: {
      d: "d",
    },
  };

  const obj2 = {
    a: "a",
    c: {
      d: "d",
    },
  };

  expect(schema.parse(obj1)).toEqual(obj1);
  expect(schema.parse(obj2)).toEqual(obj2);
  expect(nullishSchema.parse(obj1)).toEqual(obj1);
  expect(nullishSchema.parse(obj2)).toEqual(obj2);

  // These schemas should only be parseable with the nullish schema.
  const obj3 = {
    b: "b",
    c: {
      d: "d",
    },
  };
  const obj4 = {};
  expect(() => schema.parse(obj3)).toThrowError();
  expect(() => schema.parse(obj4)).toThrowError();
  expect(nullishSchema.parse(obj3)).toEqual(obj3);
  expect(nullishSchema.parse(obj4)).toEqual(obj4);

  // This one should fail both schemas.
  const obj5 = {
    c: {},
  };
  expect(() => schema.parse(obj5)).toThrowError();
  expect(() => nullishSchema.parse(obj5)).toThrowError();
});
