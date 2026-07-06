import { type IfExistsType as IfExists } from "./generated_types";

export type GenericFunction<Input, Output> =
  | ((input: Input) => Output)
  | ((input: Input) => Promise<Output>);

export interface BaseFnOpts {
  name: string;
  slug: string;
  description: string;
  ifExists: IfExists;
  tags?: string[];
  metadata?: Record<string, unknown>;
}
