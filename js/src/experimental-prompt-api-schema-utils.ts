type JsonPrimitive = string | number | boolean | null;

export type PromptJsonSchema = {
  type?: string;
  properties?: Record<string, PromptJsonSchema>;
  required?: string[];
  items?: PromptJsonSchema;
  enum?: JsonPrimitive[];
  additionalProperties?: boolean;
  description?: string;
  "x-bt-type"?: string;
};

type SchemaParser<T> = (value: unknown, path: string, root: unknown) => T;

export type SchemaDomain = "input" | "output";
export type PromptKind = "messages" | "string";

export type PromptSchemaTemplateInfo =
  | {
      type: "object";
      shape: SchemaShape;
    }
  | {
      type: "array";
      item: AnySchema;
    }
  | {
      type: "promptDefinition";
      definition: unknown;
      kind: PromptKind;
    }
  | {
      type: "attachment";
    };

export class PromptSchema<
  TParsed,
  TInput = TParsed,
  TKind = unknown,
  TDomain extends SchemaDomain = "input",
> {
  readonly _type!: TParsed;
  readonly _input!: TInput;
  readonly _kind!: TKind;
  readonly _domain!: TDomain;

  constructor(
    private readonly parser: SchemaParser<TParsed>,
    private readonly jsonSchema: () => PromptJsonSchema,
    public readonly isOptional = false,
    public readonly templateInfo?: PromptSchemaTemplateInfo,
  ) {}

  parse(value: unknown, path = "value", root: unknown = value): TParsed {
    return this.parser(value, path, root);
  }

  toJSONSchema(): PromptJsonSchema {
    return this.jsonSchema();
  }

  optional(): PromptSchema<
    TParsed | undefined,
    TInput | undefined,
    TKind,
    TDomain
  > {
    return new PromptSchema<
      TParsed | undefined,
      TInput | undefined,
      TKind,
      TDomain
    >(
      (value, path, root) =>
        value === undefined ? undefined : this.parser(value, path, root),
      () => this.jsonSchema(),
      true,
      this.templateInfo,
    );
  }
}

export type AnySchema = PromptSchema<unknown, unknown, unknown, SchemaDomain>;
export type InputSchema = PromptSchema<unknown, unknown, unknown, "input">;
export type OutputSchema = PromptSchema<unknown, unknown, unknown, "output">;

export type InferSchema<TSchema extends AnySchema> =
  TSchema extends PromptSchema<infer TParsed, unknown, unknown, SchemaDomain>
    ? TParsed
    : never;

export type InferInputSchema<TSchema extends AnySchema> =
  TSchema extends PromptSchema<unknown, infer TInput, unknown, SchemaDomain>
    ? TInput
    : never;

export type SchemaShape = Record<string, AnySchema>;
export type InputSchemaShape = Record<string, InputSchema>;
export type OutputSchemaShape = Record<string, OutputSchema>;

type OptionalParsedKeys<TShape extends SchemaShape> = {
  [K in keyof TShape]: undefined extends InferSchema<TShape[K]> ? K : never;
}[keyof TShape];

type OptionalInputKeys<TShape extends SchemaShape> = {
  [K in keyof TShape]: undefined extends InferObjectInputSchema<
    TShape[K],
    TShape,
    K
  >
    ? K
    : never;
}[keyof TShape];

type InferParsedObject<TShape extends SchemaShape> = {
  [K in keyof TShape as K extends OptionalParsedKeys<TShape>
    ? never
    : K]: InferSchema<TShape[K]>;
} & {
  [K in OptionalParsedKeys<TShape>]?: Exclude<
    InferSchema<TShape[K]>,
    undefined
  >;
};

type InferInputObject<TShape extends SchemaShape> = {
  [K in keyof TShape as K extends OptionalInputKeys<TShape>
    ? never
    : K]: InferObjectInputSchema<TShape[K], TShape, K>;
} & {
  [K in OptionalInputKeys<TShape>]?: Exclude<
    InferObjectInputSchema<TShape[K], TShape, K>,
    undefined
  >;
};

export type PromptFieldKind<
  TBuiltPrompt,
  TPromptInput,
  TPromptKind extends PromptKind,
> = {
  type: "prompt";
  builtPrompt: TBuiltPrompt;
  promptInput: TPromptInput;
  promptKind: TPromptKind;
};

type PromptInputOverrides<
  TInput,
  TParentKeys extends PropertyKey,
> = TInput extends object
  ? Omit<TInput, TParentKeys> &
      Partial<Pick<TInput, Extract<keyof TInput, TParentKeys>>>
  : TInput;

type InferObjectInputSchema<
  TSchema extends AnySchema,
  TShape extends SchemaShape,
  TKey extends keyof TShape,
> =
  TSchema extends PromptSchema<unknown, infer TInput, infer TKind, SchemaDomain>
    ? TKind extends PromptFieldKind<
        infer TBuiltPrompt,
        infer TPromptInput,
        PromptKind
      >
      ?
          | TBuiltPrompt
          | PromptInputOverrides<TPromptInput, Exclude<keyof TShape, TKey>>
          | (undefined extends TInput ? undefined : never)
      : TInput
    : never;

export function stringSchema<
  TDomain extends SchemaDomain = "input",
>(): PromptSchema<string, string, unknown, TDomain> {
  return new PromptSchema<string, string, unknown, TDomain>(
    (value, path) => {
      if (typeof value !== "string") {
        throw new Error(`${path} must be a string`);
      }
      return value;
    },
    () => ({ type: "string" }),
  );
}

export function numberSchema<
  TDomain extends SchemaDomain = "input",
>(): PromptSchema<number, number, unknown, TDomain> {
  return new PromptSchema<number, number, unknown, TDomain>(
    (value, path) => {
      if (typeof value !== "number") {
        throw new Error(`${path} must be a number`);
      }
      return value;
    },
    () => ({ type: "number" }),
  );
}

export function booleanSchema<
  TDomain extends SchemaDomain = "input",
>(): PromptSchema<boolean, boolean, unknown, TDomain> {
  return new PromptSchema<boolean, boolean, unknown, TDomain>(
    (value, path) => {
      if (typeof value !== "boolean") {
        throw new Error(`${path} must be a boolean`);
      }
      return value;
    },
    () => ({ type: "boolean" }),
  );
}

export function enumSchema<
  const TValues extends readonly [string, ...string[]],
  TDomain extends SchemaDomain = "input",
>(
  values: TValues,
): PromptSchema<TValues[number], TValues[number], unknown, TDomain> {
  return new PromptSchema<TValues[number], TValues[number], unknown, TDomain>(
    (value, path) => {
      if (typeof value !== "string" || !values.includes(value)) {
        throw new Error(`${path} must be one of ${values.join(", ")}`);
      }
      return value;
    },
    () => ({ type: "string", enum: [...values] }),
  );
}

function createArraySchema<
  TItemSchema extends AnySchema,
  TDomain extends SchemaDomain,
>(
  item: TItemSchema,
): PromptSchema<
  InferSchema<TItemSchema>[],
  InferInputSchema<TItemSchema>[],
  unknown,
  TDomain
> {
  return new PromptSchema<
    InferSchema<TItemSchema>[],
    InferInputSchema<TItemSchema>[],
    unknown,
    TDomain
  >(
    (value, path, root) => {
      if (!Array.isArray(value)) {
        throw new Error(`${path} must be an array`);
      }
      return value.map((itemValue, index) =>
        item.parse(itemValue, `${path}[${index}]`, root),
      ) as InferSchema<TItemSchema>[];
    },
    () => ({ type: "array", items: item.toJSONSchema() }),
    false,
    { type: "array", item },
  );
}

export function arraySchema<TItemSchema extends InputSchema>(
  item: TItemSchema,
): PromptSchema<
  InferSchema<TItemSchema>[],
  InferInputSchema<TItemSchema>[],
  unknown,
  "input"
> {
  return createArraySchema<TItemSchema, "input">(item);
}

export function outputArraySchema<TItemSchema extends OutputSchema>(
  item: TItemSchema,
): PromptSchema<
  InferSchema<TItemSchema>[],
  InferInputSchema<TItemSchema>[],
  unknown,
  "output"
> {
  return createArraySchema<TItemSchema, "output">(item);
}

function createObjectSchema<
  TShape extends SchemaShape,
  TDomain extends SchemaDomain,
>(
  shape: TShape,
): PromptSchema<
  InferParsedObject<TShape>,
  InferInputObject<TShape>,
  unknown,
  TDomain
> {
  return new PromptSchema<
    InferParsedObject<TShape>,
    InferInputObject<TShape>,
    unknown,
    TDomain
  >(
    (value, path, root) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${path} must be an object`);
      }
      const record = value as Record<string, unknown>;
      const rootInput = root === undefined ? record : root;
      return Object.fromEntries(
        Object.entries(shape)
          .filter(([key, schema]) => key in record || !schema.isOptional)
          .map(([key, schema]) => [
            key,
            schema.parse(record[key], `${path}.${key}`, rootInput),
          ]),
      ) as InferParsedObject<TShape>;
    },
    () => ({
      type: "object",
      properties: Object.fromEntries(
        Object.entries(shape).map(([key, schema]) => [
          key,
          schema.toJSONSchema(),
        ]),
      ),
      required: Object.entries(shape)
        .filter(([, schema]) => !schema.isOptional)
        .map(([key]) => key),
      additionalProperties: false,
    }),
    false,
    { type: "object", shape },
  );
}

export function objectSchema<TShape extends InputSchemaShape>(
  shape: TShape,
): PromptSchema<
  InferParsedObject<TShape>,
  InferInputObject<TShape>,
  unknown,
  "input"
> {
  return createObjectSchema<TShape, "input">(shape);
}

export function outputObjectSchema<TShape extends OutputSchemaShape>(
  shape: TShape,
): PromptSchema<
  InferParsedObject<TShape>,
  InferInputObject<TShape>,
  unknown,
  "output"
> {
  return createObjectSchema<TShape, "output">(shape);
}

export function unknownSchema<
  TDomain extends SchemaDomain = "input",
>(): PromptSchema<unknown, unknown, unknown, TDomain> {
  return new PromptSchema<unknown, unknown, unknown, TDomain>(
    (value) => value,
    () => ({}),
  );
}
