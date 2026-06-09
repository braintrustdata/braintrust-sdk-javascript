import { type IfExistsType as IfExists } from "./generated_types";
import { z as zodV4 } from "zod";

// Type to accept both regular Zod schemas and OpenAPI-extended ones. Widened to
// the Zod 4 ZodType since all consumers now pass v4 schemas as user-provided
// parameters/returns.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ZodSchema<T = any> =
  | zodV4.ZodType<T>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | (zodV4.ZodType<T> & { openapi?: any });

export type GenericFunction<Input, Output> =
  | ((input: Input) => Output)
  | ((input: Input) => Promise<Output>);

export type Schema<Input, Output> = Partial<{
  parameters: ZodSchema<Input>;
  returns: ZodSchema<Output>;
}>;

export interface BaseFnOpts {
  name: string;
  slug: string;
  description: string;
  ifExists: IfExists;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export type ToolOpts<
  Params,
  Returns,
  Fn extends GenericFunction<Params, Returns>,
> = Partial<BaseFnOpts> & {
  handler: Fn;
} & Schema<Params, Returns>;
