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

export class PromptSchema<TParsed, TInput = TParsed> {
  readonly _type!: TParsed;
  readonly _input!: TInput;

  constructor(
    private readonly parser: SchemaParser<TParsed>,
    private readonly jsonSchema: () => PromptJsonSchema,
    public readonly isOptional = false,
  ) {}

  parse(value: unknown, path = "value", root: unknown = value): TParsed {
    return this.parser(value, path, root);
  }

  toJSONSchema(): PromptJsonSchema {
    return this.jsonSchema();
  }

  optional(): PromptSchema<TParsed | undefined, TInput | undefined> {
    return new PromptSchema<TParsed | undefined, TInput | undefined>(
      (value, path, root) =>
        value === undefined ? undefined : this.parser(value, path, root),
      () => this.jsonSchema(),
      true,
    );
  }
}

export type InferSchema<TSchema extends PromptSchema<unknown, unknown>> =
  TSchema extends PromptSchema<infer TParsed, unknown> ? TParsed : never;

export type InferInputSchema<TSchema extends PromptSchema<unknown, unknown>> =
  TSchema extends PromptSchema<unknown, infer TInput> ? TInput : never;

type SchemaShape = Record<string, PromptSchema<unknown, unknown>>;

type OptionalParsedKeys<TShape extends SchemaShape> = {
  [K in keyof TShape]: undefined extends InferSchema<TShape[K]> ? K : never;
}[keyof TShape];

type OptionalInputKeys<TShape extends SchemaShape> = {
  [K in keyof TShape]: undefined extends InferInputSchema<TShape[K]>
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
    : K]: InferInputSchema<TShape[K]>;
} & {
  [K in OptionalInputKeys<TShape>]?: Exclude<
    InferInputSchema<TShape[K]>,
    undefined
  >;
};

const builtPromptMarker = Symbol("braintrust.experimental_prompt.built");
const promptDefinitionMarker = Symbol(
  "braintrust.experimental_prompt.definition",
);

export type PromptRole = "system" | "user" | "assistant";

export type PromptMessage = {
  role: PromptRole;
  content: string;
};

export type PromptDependencyEntry = {
  id?: string;
  slug: string;
  name?: string;
  version?: string;
  role: "root" | "include";
  parent?: string;
  input: unknown;
  metadata?: Record<string, unknown>;
};

export type PromptDependencies = {
  root: {
    id?: string;
    slug: string;
    name?: string;
    version?: string;
  };
  prompts: PromptDependencyEntry[];
  metadata?: Record<string, unknown>;
};

export type PromptRenderable =
  | PromptMessage
  | BuiltPrompt<unknown, unknown>
  | readonly PromptRenderable[];

export type PromptRenderContext<TInput> = {
  input: TInput;
  include: <TDefinition extends AnyPromptDefinition>(
    definition: TDefinition,
    input: InputOf<TDefinition>,
  ) => BuiltPrompt<ParsedInputOf<TDefinition>, OutputOf<TDefinition>>;
};

export type PromptDefinitionOptions<
  TInputSchema extends PromptSchema<unknown, unknown>,
  TOutputSchema extends PromptSchema<unknown, unknown> | undefined = undefined,
> = {
  id?: string;
  slug: string;
  name?: string;
  version?: string;
  model?: string;
  input: TInputSchema;
  output?: TOutputSchema;
  metadata?: Record<string, unknown>;
  render: (
    context: PromptRenderContext<InferSchema<TInputSchema>>,
  ) => PromptRenderable | readonly PromptRenderable[];
};

export class PromptDefinition<
  TInputSchema extends PromptSchema<unknown, unknown>,
  TOutputSchema extends PromptSchema<unknown, unknown> | undefined = undefined,
> {
  readonly [promptDefinitionMarker] = true;
  readonly id?: string;
  readonly slug: string;
  readonly name?: string;
  readonly version?: string;
  readonly model?: string;
  readonly inputSchema: TInputSchema;
  readonly outputSchema?: TOutputSchema;
  readonly metadata?: Record<string, unknown>;

  private readonly renderer: PromptDefinitionOptions<
    TInputSchema,
    TOutputSchema
  >["render"];

  constructor(opts: PromptDefinitionOptions<TInputSchema, TOutputSchema>) {
    this.id = opts.id;
    this.slug = opts.slug;
    this.name = opts.name;
    this.version = opts.version;
    this.model = opts.model;
    this.inputSchema = opts.input;
    this.outputSchema = opts.output;
    this.metadata = opts.metadata;
    this.renderer = opts.render;
  }

  build(
    input: InferInputSchema<TInputSchema>,
    opts: { metadata?: Record<string, unknown> } = {},
  ): BuiltPrompt<InferSchema<TInputSchema>, InferOutput<TOutputSchema>> {
    const parsedInput = this.inputSchema.parse(
      input,
      "input",
      input,
    ) as InferSchema<TInputSchema>;
    const rendered = this.renderer({
      input: parsedInput,
      include: (definition, includeInput) =>
        definition.build(includeInput) as BuiltPrompt<
          ParsedInputOf<typeof definition>,
          OutputOf<typeof definition>
        >,
    });
    const flattened = flattenRenderable(rendered, this.slug);
    const root = {
      id: this.id,
      slug: this.slug,
      name: this.name,
      version: this.version,
    };
    const promptMetadata =
      this.metadata || opts.metadata
        ? { ...this.metadata, ...opts.metadata }
        : undefined;
    const dependencies: PromptDependencies = {
      root,
      prompts: [
        {
          ...root,
          role: "root",
          input: sanitizeDependencyInput(parsedInput),
          metadata: promptMetadata,
        },
        ...dedupeDependencyEntries([
          ...collectBuiltPromptDependencies(parsedInput, this.slug),
          ...flattened.dependencies,
        ]),
      ],
      metadata: opts.metadata,
    };

    return new BuiltPrompt<
      InferSchema<TInputSchema>,
      InferOutput<TOutputSchema>
    >({
      definition: {
        model: this.model,
        outputSchema: this.outputSchema as
          | PromptSchema<InferOutput<TOutputSchema>>
          | undefined,
      },
      input: parsedInput,
      messages: flattened.messages,
      dependencies,
    });
  }
}

type AnyPromptDefinition = PromptDefinition<
  PromptSchema<unknown, unknown>,
  PromptSchema<unknown, unknown> | undefined
>;

type InferOutput<TOutputSchema> =
  TOutputSchema extends PromptSchema<infer TParsed, unknown>
    ? TParsed
    : unknown;

export type InputOf<TDefinition> =
  TDefinition extends PromptDefinition<
    infer TInputSchema,
    PromptSchema<unknown, unknown> | undefined
  >
    ? InferInputSchema<TInputSchema>
    : never;

export type ParsedInputOf<TDefinition> =
  TDefinition extends PromptDefinition<
    infer TInputSchema,
    PromptSchema<unknown, unknown> | undefined
  >
    ? InferSchema<TInputSchema>
    : never;

export type OutputOf<TDefinition> =
  TDefinition extends PromptDefinition<
    PromptSchema<unknown, unknown>,
    infer TOutputSchema
  >
    ? InferOutput<TOutputSchema>
    : never;

export type PromptInputValue<TDefinition extends AnyPromptDefinition> =
  | BuiltPrompt<ParsedInputOf<TDefinition>, OutputOf<TDefinition>>
  | Partial<InputOf<TDefinition>>
  | undefined;

export type DynamicPromptInputValue =
  | BuiltPrompt<unknown, unknown>
  | AnyPromptDefinition
  | {
      prompt: AnyPromptDefinition;
      input?: Record<string, unknown>;
    };

export type BuiltPromptOptions<TInput, TOutput> = {
  definition: {
    model?: string;
    outputSchema?: PromptSchema<TOutput>;
  };
  input: TInput;
  messages: PromptMessage[];
  dependencies: PromptDependencies;
};

export type PromptAdapter<TResult> = (
  builtPrompt: BuiltPrompt<unknown, unknown>,
) => TResult;

export class BuiltPrompt<TInput, TOutput> {
  readonly [builtPromptMarker] = true;
  readonly definition: { model?: string; outputSchema?: PromptSchema<TOutput> };
  readonly input: TInput;
  readonly messages: PromptMessage[];
  readonly dependencies: PromptDependencies;

  constructor(opts: BuiltPromptOptions<TInput, TOutput>) {
    this.definition = opts.definition;
    this.input = opts.input;
    this.messages = opts.messages;
    this.dependencies = opts.dependencies;
  }

  get model(): string | undefined {
    return this.definition.model;
  }

  get outputJSONSchema(): PromptJsonSchema | undefined {
    return this.definition.outputSchema?.toJSONSchema();
  }

  get spanInfo() {
    return {
      metadata: {
        prompt: this.dependencies,
      },
    };
  }

  parseOutput(value: unknown): TOutput {
    if (!this.definition.outputSchema) {
      return value as TOutput;
    }
    return this.definition.outputSchema.parse(value, "output");
  }

  asText(): string {
    return this.messages
      .map((message) => `${message.role}: ${message.content}`)
      .join("\n");
  }

  to<TResult>(adapter: PromptAdapter<TResult>): TResult {
    return adapter(this);
  }
}

export type OpenAIChatPromptArgs = {
  model?: string;
  messages: PromptMessage[];
  response_format?: {
    type: "json_schema";
    json_schema: {
      name: string;
      schema: PromptJsonSchema;
      strict: true;
    };
  };
  span_info: {
    metadata: {
      prompt: PromptDependencies;
    };
  };
};

export type AISDKGenerateObjectPromptArgs = {
  model?: string;
  messages: PromptMessage[];
  schema?: PromptJsonSchema;
  experimental_telemetry: {
    metadata: {
      braintrustPrompt: PromptDependencies;
    };
  };
};

function openAIChatAdapter(
  builtPrompt: BuiltPrompt<unknown, unknown>,
): OpenAIChatPromptArgs {
  const outputSchema = builtPrompt.outputJSONSchema;
  return {
    model: builtPrompt.model,
    messages: builtPrompt.messages,
    ...(outputSchema
      ? {
          response_format: {
            type: "json_schema" as const,
            json_schema: {
              name: schemaName(builtPrompt.dependencies.root.slug),
              schema: outputSchema,
              strict: true as const,
            },
          },
        }
      : {}),
    span_info: builtPrompt.spanInfo,
  };
}

function aiSDKGenerateObjectAdapter(
  builtPrompt: BuiltPrompt<unknown, unknown>,
): AISDKGenerateObjectPromptArgs {
  return {
    model: builtPrompt.model,
    messages: builtPrompt.messages,
    schema: builtPrompt.outputJSONSchema,
    experimental_telemetry: {
      metadata: {
        braintrustPrompt: builtPrompt.dependencies,
      },
    },
  };
}

function definePrompt<
  TInputSchema extends PromptSchema<unknown>,
  TOutputSchema extends PromptSchema<unknown> | undefined = undefined,
>(
  opts: PromptDefinitionOptions<TInputSchema, TOutputSchema>,
): PromptDefinition<TInputSchema, TOutputSchema> {
  return new PromptDefinition(opts);
}

function messageTag(role: PromptRole) {
  return (
    strings: TemplateStringsArray,
    ...values: readonly unknown[]
  ): PromptMessage => ({
    role,
    content: renderTaggedTemplate(strings, values),
  });
}

function renderTaggedTemplate(
  strings: TemplateStringsArray,
  values: readonly unknown[],
): string {
  let rendered = strings[0] ?? "";
  for (let i = 0; i < values.length; i++) {
    rendered += stringifyTemplateValue(values[i]) + (strings[i + 1] ?? "");
  }
  return rendered;
}

function stringifyTemplateValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (isBuiltPrompt(value)) {
    return value.asText();
  }
  if (isPromptDefinition(value)) {
    return `[prompt:${value.slug}${value.version ? `@${value.version}` : ""}]`;
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  return JSON.stringify(value);
}

function flattenRenderable(
  renderable: PromptRenderable | readonly PromptRenderable[],
  parent: string,
): { messages: PromptMessage[]; dependencies: PromptDependencyEntry[] } {
  const messages: PromptMessage[] = [];
  const dependencies: PromptDependencyEntry[] = [];
  const stack = Array.isArray(renderable) ? renderable : [renderable];

  for (const item of stack) {
    if (Array.isArray(item)) {
      const flattened = flattenRenderable(item, parent);
      messages.push(...flattened.messages);
      dependencies.push(...flattened.dependencies);
    } else if (isBuiltPrompt(item)) {
      messages.push(...item.messages);
      dependencies.push(
        ...item.dependencies.prompts.map((entry) => ({
          ...entry,
          role: "include" as const,
          parent,
        })),
      );
    } else {
      messages.push(item);
    }
  }

  return { messages, dependencies };
}

function collectBuiltPromptDependencies(
  value: unknown,
  parent: string,
): PromptDependencyEntry[] {
  if (isBuiltPrompt(value)) {
    return value.dependencies.prompts.map((entry) => ({
      ...entry,
      role: "include" as const,
      parent,
    }));
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) =>
      collectBuiltPromptDependencies(item, parent),
    );
  }
  if (isRecord(value)) {
    return Object.values(value).flatMap((item) =>
      collectBuiltPromptDependencies(item, parent),
    );
  }
  return [];
}

function dedupeDependencyEntries(
  entries: PromptDependencyEntry[],
): PromptDependencyEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = JSON.stringify(entry);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function sanitizeDependencyInput(value: unknown): unknown {
  if (isBuiltPrompt(value)) {
    return {
      type: "built_prompt",
      root: value.dependencies.root,
    };
  }
  if (isPromptDefinition(value)) {
    return {
      type: "prompt_definition",
      slug: value.slug,
      version: value.version,
    };
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeDependencyInput(item));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sanitizeDependencyInput(item),
      ]),
    );
  }
  return value;
}

function schemaName(slug: string): string {
  const name = slug.replace(/[^a-zA-Z0-9_-]/g, "_");
  return name.length > 0 ? `${name}_output` : "prompt_output";
}

function isBuiltPrompt(value: unknown): value is BuiltPrompt<unknown, unknown> {
  return (
    typeof value === "object" && value !== null && builtPromptMarker in value
  );
}

function isPromptDefinition(value: unknown): value is AnyPromptDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    promptDefinitionMarker in value
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergePromptInputs(parent: unknown, overrides: unknown): unknown {
  const parentInput = isRecord(parent) ? parent : {};
  if (overrides === undefined) {
    return parentInput;
  }
  if (isRecord(overrides)) {
    return { ...parentInput, ...overrides };
  }
  return overrides;
}

function buildAnyPrompt(
  definition: AnyPromptDefinition,
  input: unknown,
): BuiltPrompt<unknown, unknown> {
  return definition.build(input as never) as BuiltPrompt<unknown, unknown>;
}

function stringSchema(): PromptSchema<string> {
  return new PromptSchema(
    (value, path) => {
      if (typeof value !== "string") {
        throw new Error(`${path} must be a string`);
      }
      return value;
    },
    () => ({ type: "string" }),
  );
}

function numberSchema(): PromptSchema<number> {
  return new PromptSchema(
    (value, path) => {
      if (typeof value !== "number") {
        throw new Error(`${path} must be a number`);
      }
      return value;
    },
    () => ({ type: "number" }),
  );
}

function booleanSchema(): PromptSchema<boolean> {
  return new PromptSchema(
    (value, path) => {
      if (typeof value !== "boolean") {
        throw new Error(`${path} must be a boolean`);
      }
      return value;
    },
    () => ({ type: "boolean" }),
  );
}

function enumSchema<const TValues extends readonly [string, ...string[]]>(
  values: TValues,
): PromptSchema<TValues[number]> {
  return new PromptSchema(
    (value, path) => {
      if (typeof value !== "string" || !values.includes(value)) {
        throw new Error(`${path} must be one of ${values.join(", ")}`);
      }
      return value;
    },
    () => ({ type: "string", enum: [...values] }),
  );
}

function arraySchema<TItemSchema extends PromptSchema<unknown>>(
  item: TItemSchema,
): PromptSchema<InferSchema<TItemSchema>[], InferInputSchema<TItemSchema>[]> {
  return new PromptSchema(
    (value, path, root) => {
      if (!Array.isArray(value)) {
        throw new Error(`${path} must be an array`);
      }
      return value.map((itemValue, index) =>
        item.parse(itemValue, `${path}[${index}]`, root),
      ) as InferSchema<TItemSchema>[];
    },
    () => ({ type: "array", items: item.toJSONSchema() }),
  );
}

function objectSchema<TShape extends SchemaShape>(
  shape: TShape,
): PromptSchema<InferParsedObject<TShape>, InferInputObject<TShape>> {
  return new PromptSchema(
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
  );
}

function unknownSchema(): PromptSchema<unknown> {
  return new PromptSchema(
    (value) => value,
    () => ({}),
  );
}

function builtPromptSchema<TInput = unknown, TOutput = unknown>(): PromptSchema<
  BuiltPrompt<TInput, TOutput>
> {
  return new PromptSchema(
    (value, path) => {
      if (!isBuiltPrompt(value)) {
        throw new Error(`${path} must be a built prompt`);
      }
      return value as BuiltPrompt<TInput, TOutput>;
    },
    () => ({ type: "object", "x-bt-type": "built_prompt" }),
  );
}

function promptDefinitionSchema<
  TDefinition extends AnyPromptDefinition = AnyPromptDefinition,
>(): PromptSchema<TDefinition> {
  return new PromptSchema(
    (value, path) => {
      if (!isPromptDefinition(value)) {
        throw new Error(`${path} must be a prompt definition`);
      }
      return value as TDefinition;
    },
    () => ({ type: "object", "x-bt-type": "prompt_definition" }),
  );
}

function promptSchema<TDefinition extends AnyPromptDefinition>(
  definition: TDefinition,
): PromptSchema<
  BuiltPrompt<ParsedInputOf<TDefinition>, OutputOf<TDefinition>>,
  PromptInputValue<TDefinition>
>;
function promptSchema(): PromptSchema<
  BuiltPrompt<unknown, unknown>,
  DynamicPromptInputValue
>;
function promptSchema(
  definition?: AnyPromptDefinition,
): PromptSchema<BuiltPrompt<unknown, unknown>, unknown> {
  return new PromptSchema(
    (value, path, root) => {
      if (isBuiltPrompt(value)) {
        return value;
      }

      let promptDefinition = definition;
      let promptInput = value;
      if (!promptDefinition) {
        if (isPromptDefinition(value)) {
          promptDefinition = value;
          promptInput = undefined;
        } else if (isRecord(value) && isPromptDefinition(value.prompt)) {
          promptDefinition = value.prompt;
          promptInput = value.input;
        } else {
          throw new Error(`${path} must be a prompt or built prompt`);
        }
      } else if (isPromptDefinition(value)) {
        promptDefinition = value;
        promptInput = undefined;
      } else if (isRecord(value) && isPromptDefinition(value.prompt)) {
        promptDefinition = value.prompt;
        promptInput = value.input;
      }

      return buildAnyPrompt(
        promptDefinition,
        mergePromptInputs(root, promptInput),
      );
    },
    () => ({ type: "object", "x-bt-type": "prompt" }),
  );
}

export const s = {
  string: stringSchema,
  number: numberSchema,
  boolean: booleanSchema,
  enum: enumSchema,
  array: arraySchema,
  object: objectSchema,
  unknown: unknownSchema,
  // Requires an already-built prompt value; useful when the caller owns construction.
  builtPrompt: builtPromptSchema,
  // Accepts a built prompt, or builds a prompt definition by merging parent input plus overrides.
  prompt: promptSchema,
  // Accepts an unbuilt prompt definition as data; render code decides whether/when to build it.
  promptDefinition: promptDefinitionSchema,
};

export const prompt = {
  define: definePrompt,
  system: messageTag("system"),
  user: messageTag("user"),
  assistant: messageTag("assistant"),
  asText: (builtPrompt: BuiltPrompt<unknown, unknown>) => builtPrompt.asText(),
  isBuiltPrompt,
  isPromptDefinition,
  adapters: {
    openAIChat: openAIChatAdapter,
    aiSDKGenerateObject: aiSDKGenerateObjectAdapter,
  },
};
