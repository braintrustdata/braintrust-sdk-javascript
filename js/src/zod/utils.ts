import { zodToJsonSchema as zodToJsonSchemaV3 } from "zod-to-json-schema";
import * as z3 from "zod/v3";
import * as z4 from "zod/v4";

export type ZodSchema<Output = unknown> =
  | z3.ZodType<Output>
  | z4.ZodType<Output>;

function isZodV4(zodObject: ZodSchema): zodObject is z4.ZodType {
  return (
    typeof zodObject === "object" &&
    zodObject !== null &&
    "_zod" in zodObject &&
    zodObject._zod !== undefined
  );
}

export function zodToJsonSchema(schema: ZodSchema) {
  if (isZodV4(schema)) {
    return z4.toJSONSchema(schema, {
      target: "draft-7",
    });
  }

  return zodToJsonSchemaV3(schema);
}
