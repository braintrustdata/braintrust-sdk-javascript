import { z } from "zod/v3";
import { z as zodV4 } from "zod";
import { forEachMissingKey } from "./object_util";

export class ExtraFieldsError extends Error {
  constructor(
    public readonly key: string,
    public readonly path: string[],
  ) {
    super(
      `Extraneous key ${JSON.stringify(key)} at path ${JSON.stringify(path)}`,
    );
  }
}

// Parses a zod schema, checking afterwards that no fields were stripped during
// parsing. There are several reasons we have this function:
//
// - Marking a schema `strict` before parsing is not sufficient:
//
//   - `strict` only works at the top level of an object, not for nested
//   objects. It doesn't seem like support for deep strict
//   (https://github.com/colinhacks/zod/issues/2062) is on the roadmap.
//
//   - `strict` would not work for non-toplevel-object types like unions.
//
//  - Enforcing `strict` for all objects in our typespecs is not feasible:
//
//    - In some contexts, we may want to use the schema in a "less-strict" mode,
//    which just validates the fields it knows about. E.g. openAPI spec
//    validation, or we may just want to pull out a subset of fields we care
//    about. In these cases, if our schemas are deeply-strict, it is very hard
//    to un-strictify them.
//
// Note: this check is not exactly equivalent to a deep version of `z.strict()`.
// For instance, schemas which intentionally strip keys from objects using
// something like `z.transform` can fail this check.
export function parseNoStrip<T extends zodV4.ZodType>(
  schema: T,
  input: unknown,
) {
  const output = schema.parse(input) as zodV4.infer<T>;
  forEachMissingKey({
    lhs: output,
    rhs: input,
    fn: ({ k, path }) => {
      throw new ExtraFieldsError(k, path);
    },
  });
  return output;
}

// Given a zod object, marks all fields nullish. This operation is shallow, so
// it does not affect fields in nested objects.
//
// Basically the same as `z.partial()`, except instead of marking fields just
// optional, it marks them nullish.
// Implemented against Zod 4 (the `zod` peer). Zod 4's ZodObject no longer
// exposes the v3 `_def.shape()` constructor surface, so we rebuild the shape
// with `z.object`.
export function objectNullish<Shape extends zodV4.ZodRawShape>(
  object: zodV4.ZodObject<Shape>,
): zodV4.ZodObject<{
  [K in keyof Shape]: zodV4.ZodOptional<zodV4.ZodNullable<Shape[K]>>;
}> {
  const nullishShape = Object.fromEntries(
    Object.entries(object.shape).map(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- shape values are zod schemas; .nullish() is available at runtime
      ([key, value]: [string, any]) => [key, value.nullish()],
    ),
  );
  // The precise per-key mapped type cannot be inferred from the dynamically
  // constructed shape, so we assert the documented return type. Runtime matches:
  // every field is wrapped with .nullish().
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- dynamic shape construction; runtime matches the asserted type
  return zodV4.object(nullishShape) as zodV4.ZodObject<{
    [K in keyof Shape]: zodV4.ZodOptional<zodV4.ZodNullable<Shape[K]>>;
  }>;
}
