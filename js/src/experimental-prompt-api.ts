import { adapters } from "./experimental-prompt-adapters";
import type { PromptDefinition as MustachePromptDefinition } from "./prompt-schemas";

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

type SchemaDomain = "input" | "output";
type PromptKind = "messages" | "string";

type PromptSchemaTemplateInfo =
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
      definition: AnyPromptDefinition;
      kind: PromptKind;
    };

class PromptSchema<
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

type AnySchema = PromptSchema<unknown, unknown, unknown, SchemaDomain>;
type InputSchema = PromptSchema<unknown, unknown, unknown, "input">;
type OutputSchema = PromptSchema<unknown, unknown, unknown, "output">;

type InferSchema<TSchema extends AnySchema> =
  TSchema extends PromptSchema<infer TParsed, unknown, unknown, SchemaDomain>
    ? TParsed
    : never;

type InferInputSchema<TSchema extends AnySchema> =
  TSchema extends PromptSchema<unknown, infer TInput, unknown, SchemaDomain>
    ? TInput
    : never;

type SchemaShape = Record<string, AnySchema>;
type InputSchemaShape = Record<string, InputSchema>;
type OutputSchemaShape = Record<string, OutputSchema>;

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

type InferObjectInputSchema<
  TSchema extends AnySchema,
  TShape extends SchemaShape,
  TKey extends keyof TShape,
> =
  TSchema extends PromptSchema<unknown, infer TInput, infer TKind, SchemaDomain>
    ? TKind extends PromptFieldKind<infer TDefinition, infer TPromptKind>
      ? PromptInputValueForObject<
          TDefinition,
          TPromptKind,
          TShape,
          TKey,
          TInput
        >
      : TInput
    : never;

const builtPromptMarker = Symbol("braintrust.experimental_prompt.built");
const promptDefinitionMarker = Symbol(
  "braintrust.experimental_prompt.definition",
);
const promptTextMarker = Symbol("braintrust.experimental_prompt.text");
const promptDependencyMarker = Symbol(
  "braintrust.experimental_prompt.dependencies",
);
const mustacheTemplateValueMarker = Symbol(
  "braintrust.experimental_prompt.mustache_template_value",
);
const templateValueStateMarker = Symbol(
  "braintrust.experimental_prompt.template_value_state",
);

type PromptRole = "system" | "user" | "assistant";
export type PromptMessage = {
  role: PromptRole;
  content: string;
};

type PromptMessageWithDependencies = PromptMessage & {
  readonly [promptDependencyMarker]?: PromptDependencyEntry[];
};

type PromptText = {
  readonly [promptTextMarker]: true;
  readonly content: string;
  readonly dependencies: PromptDependencyEntry[];
};

type PromptVariableMode = "runtime" | "mustache";

type TemplateValueState = {
  readonly path: string;
  readonly mode: PromptVariableMode;
  readonly runtimeValue?: unknown;
  readonly sectionPath?: string;
  readonly relativePath?: string;
};

type MustacheTemplateValue = {
  readonly [mustacheTemplateValueMarker]: true;
  readonly [templateValueStateMarker]: TemplateValueState;
};

type PromptDependencyEntry = {
  id?: string;
  slug: string;
  name?: string;
  version?: string;
  role: "root" | "include";
  parent?: string;
  input: unknown;
};

export type PromptDependencies = {
  root: {
    id?: string;
    slug: string;
    name?: string;
    version?: string;
  };
  prompts: PromptDependencyEntry[];
};

export type ExperimentalPromptData = {
  id?: string;
  slug: string;
  name?: string;
  version?: string;
  model?: string;
  inputSchema: PromptJsonSchema;
  outputSchema?: PromptJsonSchema;
  dependencies: PromptDependencies;
} & (
  | {
      kind: "messages";
      messages: PromptMessage[];
    }
  | {
      kind: "string";
      content: string;
    }
);

type PromptRenderResult = readonly PromptMessage[] | PromptText;

type PromptRenderContext<TVariables, TValues> = {
  variables: TVariables;
  values: TValues;
  include: <TDefinition extends AnyPromptDefinition>(
    definition: TDefinition,
    input: InputOf<TDefinition>,
  ) => BuiltPromptOf<TDefinition>;
};

type PromptTemplateScope = {
  rootKeys: ReadonlySet<string>;
  pathForKey: (key: string) => string;
};

type TemplateNestedPromptBuilder = (
  definition: AnyPromptDefinition,
  kind: PromptKind,
  fieldPath: string,
) => AnyBuiltPrompt;

type PromptListTag = (
  strings: TemplateStringsArray,
  ...values: readonly unknown[]
) => PromptText;

type PromptTemplateField<TValue> = TValue extends AnyBuiltPrompt
  ? TValue
  : unknown &
      (TValue extends readonly (infer TItem)[]
        ? { list: PromptListTag & PromptTemplateField<TItem> }
        : TValue extends object
          ? { [K in keyof TValue]: PromptTemplateField<TValue[K]> }
          : {});

type TemplateRenderContext = {
  sectionPath?: string;
  item?: unknown;
};

type InputSchemaHelpers = typeof inputSchemaHelpers;
type OutputSchemaHelpers = typeof outputSchemaHelpers;

type PromptDefinitionOptions<
  TInputSchema extends InputSchema,
  TOutputSchema extends OutputSchema | undefined,
  TRenderResult extends PromptRenderResult,
> = {
  id?: string;
  slug: string;
  name?: string;
  version?: string;
  model?: string;
  input: (s: InputSchemaHelpers) => TInputSchema;
  output?: (s: OutputSchemaHelpers) => TOutputSchema;
  render: (
    context: PromptRenderContext<
      PromptTemplateField<InferSchema<TInputSchema>>,
      InferSchema<TInputSchema>
    >,
  ) => TRenderResult;
};

class PromptDefinition<
  TInputSchema extends InputSchema,
  TOutputSchema extends OutputSchema | undefined,
  TRenderResult extends PromptRenderResult,
> {
  readonly [promptDefinitionMarker] = true;
  readonly id?: string;
  readonly slug: string;
  readonly name?: string;
  readonly version?: string;
  readonly model?: string;
  readonly inputSchema: TInputSchema;
  readonly outputSchema?: TOutputSchema;

  private readonly renderer: PromptDefinitionOptions<
    TInputSchema,
    TOutputSchema,
    TRenderResult
  >["render"];

  constructor(
    opts: PromptDefinitionOptions<TInputSchema, TOutputSchema, TRenderResult>,
  ) {
    this.id = opts.id;
    this.slug = opts.slug;
    this.name = opts.name;
    this.version = opts.version;
    this.model = opts.model;
    if (typeof opts.input !== "function") {
      throw new Error("input must be a schema function");
    }
    if (opts.output !== undefined && typeof opts.output !== "function") {
      throw new Error("output must be a schema function");
    }
    this.inputSchema = opts.input(inputSchemaHelpers);
    this.outputSchema = opts.output?.(outputSchemaHelpers);
    this.renderer = opts.render;
  }

  build(
    input: InferInputSchema<TInputSchema>,
  ): BuiltPromptForRenderResult<
    InferSchema<TInputSchema>,
    InferOutput<TOutputSchema>,
    TRenderResult
  > {
    const parsedInput = this.inputSchema.parse(
      input,
      "input",
      input,
    ) as InferSchema<TInputSchema>;
    const variables = createPromptVariables(
      this.inputSchema,
      createRootTemplateScope(this.inputSchema),
      "runtime",
      parsedInput,
      () => {
        throw new Error("prompt variables could not resolve a built prompt");
      },
    ) as PromptTemplateField<InferSchema<TInputSchema>>;
    const rendered = this.renderer({
      variables,
      values: parsedInput,
      include: (definition, includeInput) =>
        definition.build(includeInput) as BuiltPromptOf<typeof definition>,
    });
    const root = {
      id: this.id,
      slug: this.slug,
      name: this.name,
      version: this.version,
    };

    if (isPromptText(rendered)) {
      const dependencies = createPromptDependencies(root, parsedInput, [
        ...collectBuiltPromptDependencies(parsedInput, this.slug),
        ...collectDependencyEntries(rendered.dependencies, this.slug),
      ]);

      return new BuiltStringPrompt<
        InferSchema<TInputSchema>,
        InferOutput<TOutputSchema>
      >({
        definition: {
          model: this.model,
          inputSchema: this.inputSchema as PromptSchema<
            InferSchema<TInputSchema>,
            unknown,
            unknown,
            "input"
          >,
          outputSchema: this.outputSchema as
            | PromptSchema<
                InferOutput<TOutputSchema>,
                unknown,
                unknown,
                "output"
              >
            | undefined,
        },
        input: parsedInput,
        content: rendered.content,
        dependencies,
      }) as BuiltPromptForRenderResult<
        InferSchema<TInputSchema>,
        InferOutput<TOutputSchema>,
        TRenderResult
      >;
    }

    if (!Array.isArray(rendered)) {
      throw new Error("render must return a message array or prompt.text");
    }

    const messages = rendered.map((message, index) =>
      assertPromptMessage(message, `render[${index}]`),
    );
    const dependencies = createPromptDependencies(root, parsedInput, [
      ...collectBuiltPromptDependencies(parsedInput, this.slug),
      ...collectMessageDependencies(messages, this.slug),
    ]);

    return new BuiltMessagesPrompt<
      InferSchema<TInputSchema>,
      InferOutput<TOutputSchema>
    >({
      definition: {
        model: this.model,
        inputSchema: this.inputSchema as PromptSchema<
          InferSchema<TInputSchema>,
          unknown,
          unknown,
          "input"
        >,
        outputSchema: this.outputSchema as
          | PromptSchema<InferOutput<TOutputSchema>, unknown, unknown, "output">
          | undefined,
      },
      input: parsedInput,
      messages,
      dependencies,
    }) as BuiltPromptForRenderResult<
      InferSchema<TInputSchema>,
      InferOutput<TOutputSchema>,
      TRenderResult
    >;
  }

  toPromptData(): ExperimentalPromptData {
    return this.compileTemplate(createRootTemplateScope(this.inputSchema));
  }

  private compileTemplate(scope: PromptTemplateScope): ExperimentalPromptData {
    const variables = createPromptVariables(
      this.inputSchema,
      scope,
      "mustache",
      undefined,
      (definition, kind, fieldPath) => {
        const nested = definition.compileTemplate(
          createNestedTemplateScope(
            definition.inputSchema,
            scope.rootKeys,
            fieldPath,
          ),
        );
        return templateDataToBuiltPrompt(nested, kind);
      },
    ) as PromptTemplateField<InferSchema<TInputSchema>>;
    const rendered = this.renderer({
      variables,
      values: createUnavailableValuesProxy() as InferSchema<TInputSchema>,
      include: (definition) => {
        const nested = definition.compileTemplate(
          createRootTemplateScope(definition.inputSchema),
        );
        return templateDataToBuiltPrompt(nested, nested.kind) as BuiltPromptOf<
          typeof definition
        >;
      },
    });
    const root = promptDefinitionRoot(this);
    const inputSnapshot = createTemplateDependencyInput(
      this.inputSchema,
      scope,
    );

    if (isPromptText(rendered)) {
      const dependencies = createPromptDependencies(root, inputSnapshot, [
        ...collectBuiltPromptDependencies(variables, this.slug),
        ...collectDependencyEntries(rendered.dependencies, this.slug),
      ]);

      return {
        ...root,
        model: this.model,
        inputSchema: this.inputSchema.toJSONSchema(),
        outputSchema: this.outputSchema?.toJSONSchema(),
        dependencies,
        kind: "string",
        content: rendered.content,
      };
    }

    if (!Array.isArray(rendered)) {
      throw new Error("render must return a message array or prompt.text");
    }

    const messages = rendered.map((message, index) =>
      assertPromptMessage(message, `render[${index}]`),
    );
    const dependencies = createPromptDependencies(root, inputSnapshot, [
      ...collectBuiltPromptDependencies(variables, this.slug),
      ...collectMessageDependencies(messages, this.slug),
    ]);

    return {
      ...root,
      model: this.model,
      inputSchema: this.inputSchema.toJSONSchema(),
      outputSchema: this.outputSchema?.toJSONSchema(),
      dependencies,
      kind: "messages",
      messages,
    };
  }
}

type AnyPromptDefinition = PromptDefinition<
  InputSchema,
  OutputSchema | undefined,
  PromptRenderResult
>;

type AnyMessagesPromptDefinition = PromptDefinition<
  InputSchema,
  OutputSchema | undefined,
  readonly PromptMessage[]
>;

type AnyStringPromptDefinition = PromptDefinition<
  InputSchema,
  OutputSchema | undefined,
  PromptText
>;

type InferOutput<TOutputSchema> =
  TOutputSchema extends PromptSchema<infer TParsed, unknown, unknown, "output">
    ? TParsed
    : unknown;

type InputOf<TDefinition> =
  TDefinition extends PromptDefinition<
    infer TInputSchema,
    OutputSchema | undefined,
    PromptRenderResult
  >
    ? InferInputSchema<TInputSchema>
    : never;

type ParsedInputOf<TDefinition> =
  TDefinition extends PromptDefinition<
    infer TInputSchema,
    OutputSchema | undefined,
    PromptRenderResult
  >
    ? InferSchema<TInputSchema>
    : never;

type OutputOf<TDefinition> =
  TDefinition extends PromptDefinition<
    InputSchema,
    infer TOutputSchema,
    PromptRenderResult
  >
    ? InferOutput<TOutputSchema>
    : never;

type BuiltPromptOf<TDefinition> =
  TDefinition extends PromptDefinition<
    infer TInputSchema,
    infer TOutputSchema,
    infer TRenderResult
  >
    ? BuiltPromptForRenderResult<
        InferSchema<TInputSchema>,
        InferOutput<TOutputSchema>,
        TRenderResult
      >
    : never;

type BuiltPromptForRenderResult<TInput, TOutput, TRenderResult> =
  TRenderResult extends PromptText
    ? BuiltStringPrompt<TInput, TOutput>
    : TRenderResult extends readonly PromptMessage[]
      ? BuiltMessagesPrompt<TInput, TOutput>
      : never;

type BuiltPromptForKind<
  TInput,
  TOutput,
  TKind extends PromptKind,
> = TKind extends "messages"
  ? BuiltMessagesPrompt<TInput, TOutput>
  : BuiltStringPrompt<TInput, TOutput>;

type PromptFieldKind<
  TDefinition extends AnyPromptDefinition,
  TPromptKind extends PromptKind,
> = {
  type: "prompt";
  definition: TDefinition;
  promptKind: TPromptKind;
};

type PromptInputOverrides<
  TInput,
  TParentKeys extends PropertyKey,
> = TInput extends object
  ? Omit<TInput, TParentKeys> &
      Partial<Pick<TInput, Extract<keyof TInput, TParentKeys>>>
  : TInput;

type PromptInputValue<
  TDefinition extends AnyPromptDefinition,
  TPromptKind extends PromptKind,
> =
  | BuiltPromptForKind<
      ParsedInputOf<TDefinition>,
      OutputOf<TDefinition>,
      TPromptKind
    >
  | InputOf<TDefinition>;

type PromptInputValueForObject<
  TDefinition extends AnyPromptDefinition,
  TPromptKind extends PromptKind,
  TShape extends SchemaShape,
  TKey extends keyof TShape,
  TInput,
> =
  | BuiltPromptForKind<
      ParsedInputOf<TDefinition>,
      OutputOf<TDefinition>,
      TPromptKind
    >
  | PromptInputOverrides<InputOf<TDefinition>, Exclude<keyof TShape, TKey>>
  | (undefined extends TInput ? undefined : never);

type BuiltPromptOptions<TInput, TOutput> = {
  definition: {
    model?: string;
    inputSchema: PromptSchema<TInput, unknown, unknown, "input">;
    outputSchema?: PromptSchema<TOutput, unknown, unknown, "output">;
  };
  input: TInput;
  dependencies: PromptDependencies;
};

type BuiltMessagesPromptOptions<TInput, TOutput> = BuiltPromptOptions<
  TInput,
  TOutput
> & {
  messages: PromptMessage[];
};

type BuiltStringPromptOptions<TInput, TOutput> = BuiltPromptOptions<
  TInput,
  TOutput
> & {
  content: string;
};

type PromptAdapterInput<TInput, TOutput> = {
  model?: string;
  inputSchema: PromptSchema<TInput, unknown, unknown, "input">;
  outputSchema?: PromptSchema<TOutput, unknown, unknown, "output">;
  input: TInput;
  dependencies: PromptDependencies;
} & (
  | {
      kind: "messages";
      messages: PromptMessage[];
    }
  | {
      kind: "string";
      content: string;
      messages: PromptMessage[];
    }
);

type Simplify<T> = { [K in keyof T]: T[K] } & {};

type DeepMerge<TBase, TExtension> = Simplify<
  Omit<TBase, keyof TExtension> & {
    [K in keyof TExtension]: K extends keyof TBase
      ? DeepMergeValue<TBase[K], TExtension[K]>
      : TExtension[K];
  }
>;

type DeepMergeValue<TBase, TExtension> = TBase extends readonly unknown[]
  ? TExtension
  : TExtension extends readonly unknown[]
    ? TExtension
    : TBase extends object
      ? TExtension extends object
        ? DeepMerge<TBase, TExtension>
        : TExtension
      : TExtension;

type PromptExtension = Record<string, unknown>;
type PromptAdapterResult = PromptExtension;

type Extendable<T extends PromptAdapterResult> = T & {
  extend<TExtension extends PromptExtension>(
    extension: TExtension,
  ): Extendable<DeepMerge<T, TExtension>>;
};

type PromptAdapter<TResult extends PromptAdapterResult> = (
  builtPrompt: PromptAdapterInput<unknown, unknown>,
) => TResult;

class BuiltMessagesPrompt<TInput, TOutput> implements Iterable<PromptMessage> {
  readonly [builtPromptMarker] = true;
  readonly kind = "messages";
  readonly definition: {
    model?: string;
    inputSchema: PromptSchema<TInput, unknown, unknown, "input">;
    outputSchema?: PromptSchema<TOutput, unknown, unknown, "output">;
  };
  readonly input: TInput;
  readonly messages: PromptMessage[];
  readonly dependencies: PromptDependencies;

  constructor(opts: BuiltMessagesPromptOptions<TInput, TOutput>) {
    this.definition = opts.definition;
    this.input = opts.input;
    this.messages = opts.messages;
    this.dependencies = opts.dependencies;
  }

  [Symbol.iterator](): Iterator<PromptMessage> {
    return this.messages
      .map((message) =>
        attachDependenciesToMessage(message, this.dependencies.prompts),
      )
      [Symbol.iterator]();
  }

  to<TResult extends PromptAdapterResult>(
    adapter: PromptAdapter<TResult>,
  ): Extendable<TResult> {
    return makeExtendableAdapterResult(
      adapter({
        kind: "messages",
        model: this.definition.model,
        inputSchema: this.definition.inputSchema,
        outputSchema: this.definition.outputSchema,
        input: this.input,
        messages: this.messages,
        dependencies: this.dependencies,
      }),
    );
  }
}

class BuiltStringPrompt<TInput, TOutput> {
  readonly [builtPromptMarker] = true;
  readonly kind = "string";
  readonly definition: {
    model?: string;
    inputSchema: PromptSchema<TInput, unknown, unknown, "input">;
    outputSchema?: PromptSchema<TOutput, unknown, unknown, "output">;
  };
  readonly input: TInput;
  readonly content: string;
  readonly dependencies: PromptDependencies;

  constructor(opts: BuiltStringPromptOptions<TInput, TOutput>) {
    this.definition = opts.definition;
    this.input = opts.input;
    this.content = opts.content;
    this.dependencies = opts.dependencies;
  }

  to<TResult extends PromptAdapterResult>(
    adapter: PromptAdapter<TResult>,
  ): Extendable<TResult> {
    return makeExtendableAdapterResult(
      adapter({
        kind: "string",
        model: this.definition.model,
        inputSchema: this.definition.inputSchema,
        outputSchema: this.definition.outputSchema,
        input: this.input,
        content: this.content,
        messages: [{ role: "user", content: this.content }],
        dependencies: this.dependencies,
      }),
    );
  }
}

function makeExtendableAdapterResult<TResult extends PromptAdapterResult>(
  result: TResult,
): Extendable<TResult> {
  if (!isMergeableObject(result)) {
    throw new Error("prompt adapters must return an object");
  }

  const extendable = result as Extendable<TResult>;
  Object.defineProperty(extendable, "extend", {
    value: <TExtension extends PromptExtension>(extension: TExtension) => {
      if (!isMergeableObject(extension)) {
        throw new Error("extend must receive an object");
      }
      return makeExtendableAdapterResult(
        deepMergeObjects(extendable, extension) as DeepMerge<
          TResult,
          TExtension
        >,
      );
    },
    enumerable: false,
    configurable: true,
  });
  return extendable;
}

function deepMergeObjects(
  base: PromptExtension,
  extension: PromptExtension,
): PromptExtension {
  const merged: PromptExtension = { ...base };
  for (const [key, value] of Object.entries(extension)) {
    const baseValue = merged[key];
    merged[key] =
      isMergeableObject(baseValue) && isMergeableObject(value)
        ? deepMergeObjects(baseValue, value)
        : value;
  }
  return merged;
}

function isMergeableObject(value: unknown): value is PromptExtension {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type AnyBuiltPrompt =
  | BuiltMessagesPrompt<unknown, unknown>
  | BuiltStringPrompt<unknown, unknown>;

function definePrompt<
  TInputSchema extends InputSchema,
  TOutputSchema extends OutputSchema | undefined = undefined,
  TRenderResult extends PromptRenderResult = PromptRenderResult,
>(
  opts: PromptDefinitionOptions<TInputSchema, TOutputSchema, TRenderResult>,
): PromptDefinition<TInputSchema, TOutputSchema, TRenderResult> {
  return new PromptDefinition(opts);
}

function messageTag(role: PromptRole) {
  return (
    strings: TemplateStringsArray,
    ...values: readonly unknown[]
  ): PromptMessage => {
    const rendered = renderTaggedTemplate(strings, values);
    return attachDependenciesToMessage(
      { role, content: rendered.content },
      rendered.dependencies,
    );
  };
}

function textTag(
  strings: TemplateStringsArray,
  ...values: readonly unknown[]
): PromptText {
  const rendered = renderTaggedTemplate(strings, values);
  return {
    [promptTextMarker]: true,
    content: rendered.content,
    dependencies: rendered.dependencies,
  };
}

function renderTaggedTemplate(
  strings: TemplateStringsArray,
  values: readonly unknown[],
  context?: TemplateRenderContext,
): { content: string; dependencies: PromptDependencyEntry[] } {
  let content = strings[0] ?? "";
  const dependencies: PromptDependencyEntry[] = [];
  for (let i = 0; i < values.length; i++) {
    const rendered = stringifyTemplateValue(values[i], context);
    content += rendered.content + (strings[i + 1] ?? "");
    dependencies.push(...rendered.dependencies);
  }
  return { content, dependencies };
}

function stringifyTemplateValue(
  value: unknown,
  context?: TemplateRenderContext,
): {
  content: string;
  dependencies: PromptDependencyEntry[];
};
function stringifyTemplateValue(
  value: unknown,
  context?: TemplateRenderContext,
): {
  content: string;
  dependencies: PromptDependencyEntry[];
} {
  if (value === undefined || value === null) {
    return { content: "", dependencies: [] };
  }
  if (isMustacheTemplateValue(value)) {
    const state = value[templateValueStateMarker];
    if (state.mode === "mustache") {
      if (context?.sectionPath && state.sectionPath === context.sectionPath) {
        return {
          content: `{{${state.relativePath ?? "."}}}`,
          dependencies: [],
        };
      }
      return { content: `{{${state.path}}}`, dependencies: [] };
    }

    const runtimeValue =
      context?.sectionPath && state.sectionPath === context.sectionPath
        ? getPathValue(context.item, state.relativePath)
        : state.runtimeValue;
    return { content: stringifyRuntimeValue(runtimeValue), dependencies: [] };
  }
  if (isBuiltStringPrompt(value)) {
    return { content: value.content, dependencies: value.dependencies.prompts };
  }
  if (isBuiltMessagesPrompt(value)) {
    throw new Error("message prompts cannot be interpolated as text");
  }
  if (isPromptText(value)) {
    return { content: value.content, dependencies: value.dependencies };
  }
  if (isPromptDefinition(value)) {
    return {
      content: `[prompt:${value.slug}${value.version ? `@${value.version}` : ""}]`,
      dependencies: [],
    };
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return { content: String(value), dependencies: [] };
  }
  return { content: JSON.stringify(value), dependencies: [] };
}

function attachDependenciesToMessage(
  message: PromptMessage,
  dependencies: PromptDependencyEntry[],
): PromptMessage {
  if (dependencies.length === 0) {
    return message;
  }
  const messageWithDependencies: PromptMessageWithDependencies = { ...message };
  Object.defineProperty(messageWithDependencies, promptDependencyMarker, {
    value: dependencies,
    enumerable: false,
  });
  return messageWithDependencies;
}

function assertPromptMessage(value: unknown, path: string): PromptMessage {
  if (
    !isRecord(value) ||
    (value.role !== "system" &&
      value.role !== "user" &&
      value.role !== "assistant") ||
    typeof value.content !== "string"
  ) {
    throw new Error(`${path} must be a prompt message`);
  }
  return value as PromptMessage;
}

function createRootTemplateScope(
  inputSchema: InputSchema,
): PromptTemplateScope {
  return {
    rootKeys: getObjectSchemaKeys(inputSchema),
    pathForKey: (key) => key,
  };
}

function createNestedTemplateScope(
  inputSchema: InputSchema,
  rootKeys: ReadonlySet<string>,
  fieldPath: string,
): PromptTemplateScope {
  const nestedKeys = getObjectSchemaKeys(inputSchema);
  const fieldKey = lastPathSegment(fieldPath);
  return {
    rootKeys: new Set([...rootKeys, ...nestedKeys]),
    pathForKey: (key) =>
      rootKeys.has(key) && key !== fieldKey ? key : `${fieldPath}.${key}`,
  };
}

function getObjectSchemaKeys(schema: InputSchema): Set<string> {
  return schema.templateInfo?.type === "object"
    ? new Set(Object.keys(schema.templateInfo.shape))
    : new Set();
}

function lastPathSegment(path: string): string {
  return path.split(".").at(-1) ?? path;
}

function createPromptVariables(
  schema: InputSchema,
  scope: PromptTemplateScope,
  mode: PromptVariableMode,
  runtimeValue: unknown,
  nestedPromptBuilder: TemplateNestedPromptBuilder,
  path = "input",
  sectionPath?: string,
  relativePath?: string,
): unknown {
  if (mode === "runtime" && isBuiltPrompt(runtimeValue)) {
    return runtimeValue;
  }

  const templateInfo = schema.templateInfo;
  if (templateInfo?.type === "object") {
    return createPromptVariableObject(
      templateInfo.shape,
      scope,
      mode,
      runtimeValue,
      nestedPromptBuilder,
      path === "input" ? undefined : path,
      sectionPath,
      relativePath,
    );
  }

  if (templateInfo?.type === "array") {
    return createPromptVariableArray(
      templateInfo.item as InputSchema,
      scope,
      mode,
      runtimeValue,
      nestedPromptBuilder,
      path,
      sectionPath,
      relativePath,
    );
  }

  if (templateInfo?.type === "promptDefinition") {
    return mode === "runtime"
      ? runtimeValue
      : nestedPromptBuilder(templateInfo.definition, templateInfo.kind, path);
  }

  return createPromptVariableValue({
    path,
    mode,
    runtimeValue,
    sectionPath,
    relativePath,
  });
}

function createPromptVariableObject(
  shape: SchemaShape,
  scope: PromptTemplateScope,
  mode: PromptVariableMode,
  runtimeValue: unknown,
  nestedPromptBuilder: TemplateNestedPromptBuilder,
  basePath?: string,
  sectionPath?: string,
  relativePath?: string,
): Record<string, unknown> {
  const variableObject: Record<string, unknown> = {};
  if (basePath) {
    attachPromptVariableValue(variableObject, {
      path: basePath,
      mode,
      runtimeValue,
      sectionPath,
      relativePath,
    });
  }
  for (const [key, schema] of Object.entries(shape)) {
    const path = basePath ? `${basePath}.${key}` : scope.pathForKey(key);
    const childRelativePath = sectionPath
      ? relativePath
        ? `${relativePath}.${key}`
        : key
      : undefined;
    variableObject[key] = createPromptVariables(
      schema as InputSchema,
      scope,
      mode,
      getObjectProperty(runtimeValue, key),
      nestedPromptBuilder,
      path,
      sectionPath,
      childRelativePath,
    );
  }
  return variableObject;
}

function createPromptVariableArray(
  itemSchema: InputSchema,
  scope: PromptTemplateScope,
  mode: PromptVariableMode,
  runtimeValue: unknown,
  nestedPromptBuilder: TemplateNestedPromptBuilder,
  path: string,
  sectionPath?: string,
  relativePath?: string,
): Record<string, unknown> {
  const variableArray = createPromptVariableValue({
    path,
    mode,
    runtimeValue,
    sectionPath,
    relativePath,
  }) as Record<string, unknown>;
  const listSectionPath = path;
  const listTag = ((
    strings: TemplateStringsArray,
    ...values: readonly unknown[]
  ): PromptText => {
    if (mode === "mustache") {
      const rendered = renderTaggedTemplate(strings, values, {
        sectionPath: listSectionPath,
      });
      const sectionName = relativePath ?? path;
      return {
        [promptTextMarker]: true,
        content: `{{#${sectionName}}}${rendered.content}{{/${sectionName}}}`,
        dependencies: rendered.dependencies,
      };
    }

    const items = Array.isArray(runtimeValue) ? runtimeValue : [];
    const renderedItems = items.map((item) =>
      renderTaggedTemplate(strings, values, {
        sectionPath: listSectionPath,
        item,
      }),
    );
    return {
      [promptTextMarker]: true,
      content: renderedItems.map((item) => item.content).join(""),
      dependencies: renderedItems.flatMap((item) => item.dependencies),
    };
  }) as PromptListTag & Record<string, unknown>;

  attachPromptVariableValue(listTag, {
    path,
    mode,
    runtimeValue,
    sectionPath: listSectionPath,
    relativePath: undefined,
  });
  const itemVariables = createPromptVariables(
    itemSchema,
    scope,
    mode,
    undefined,
    nestedPromptBuilder,
    path,
    listSectionPath,
  );
  if (isRecord(itemVariables)) {
    for (const key of Object.keys(itemVariables)) {
      Object.defineProperty(
        listTag,
        key,
        Object.getOwnPropertyDescriptor(itemVariables, key) ?? {
          value: itemVariables[key],
          enumerable: true,
        },
      );
    }
  }

  Object.defineProperty(variableArray, "list", {
    value: listTag,
    enumerable: true,
  });
  return variableArray;
}

function createTemplateDependencyInput(
  schema: InputSchema,
  scope: PromptTemplateScope,
  path = "input",
): unknown {
  const templateInfo = schema.templateInfo;
  if (templateInfo?.type === "object") {
    return Object.fromEntries(
      Object.entries(templateInfo.shape).map(([key, childSchema]) => {
        const childPath =
          path === "input" ? scope.pathForKey(key) : `${path}.${key}`;
        return [
          key,
          createTemplateDependencyInput(
            childSchema as InputSchema,
            scope,
            childPath,
          ),
        ];
      }),
    );
  }

  if (templateInfo?.type === "array") {
    return `{{${path}}}`;
  }

  if (templateInfo?.type === "promptDefinition") {
    return {
      type:
        templateInfo.kind === "messages"
          ? "template_messages_prompt"
          : "template_string_prompt",
      root: promptDefinitionRoot(templateInfo.definition),
    };
  }

  return `{{${path}}}`;
}

function createPromptVariableValue(
  state: TemplateValueState,
): MustacheTemplateValue {
  return attachPromptVariableValue({}, state) as MustacheTemplateValue;
}

function attachPromptVariableValue<T extends object>(
  value: T,
  state: TemplateValueState,
): T {
  Object.defineProperties(value, {
    [mustacheTemplateValueMarker]: {
      value: true,
      enumerable: false,
    },
    [templateValueStateMarker]: {
      value: state,
      enumerable: false,
    },
    toString: {
      value: () => stringifyTemplateValue(value).content,
      enumerable: false,
    },
    valueOf: {
      value: () => stringifyTemplateValue(value).content,
      enumerable: false,
    },
    [Symbol.toPrimitive]: {
      value: () => stringifyTemplateValue(value).content,
      enumerable: false,
    },
  });
  return value;
}

function getObjectProperty(value: unknown, key: string): unknown {
  if (isRecord(value)) {
    return value[key];
  }
  if (Array.isArray(value)) {
    return value[Number(key)];
  }
  return undefined;
}

function getPathValue(value: unknown, path?: string): unknown {
  if (!path) {
    return value;
  }
  return path
    .split(".")
    .reduce<unknown>((current, key) => getObjectProperty(current, key), value);
}

function stringifyRuntimeValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
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

function createUnavailableValuesProxy(): unknown {
  return new Proxy(
    {},
    {
      get(_target, key) {
        if (typeof key === "symbol") {
          return undefined;
        }
        throw new Error(
          "Runtime values are not available while exporting prompt data; use variables in prompt templates.",
        );
      },
    },
  );
}

function isMustacheTemplateValue(
  value: unknown,
): value is MustacheTemplateValue {
  return (
    typeof value === "object" &&
    value !== null &&
    mustacheTemplateValueMarker in value
  );
}

function promptDefinitionRoot(
  definition: AnyPromptDefinition,
): PromptDependencies["root"] {
  return {
    id: definition.id,
    slug: definition.slug,
    name: definition.name,
    version: definition.version,
  };
}

function templateDataToBuiltPrompt(
  data: ExperimentalPromptData,
  kind: PromptKind,
): AnyBuiltPrompt {
  if (data.kind !== kind) {
    const label = kind === "messages" ? "messages" : "string";
    throw new Error(`template prompt must be a ${label} prompt`);
  }

  const definition = {
    model: data.model,
    inputSchema: unknownSchema(),
    outputSchema: undefined,
  };
  if (data.kind === "messages") {
    return new BuiltMessagesPrompt({
      definition,
      input: data.dependencies.prompts[0]?.input,
      messages: data.messages,
      dependencies: data.dependencies,
    });
  }
  return new BuiltStringPrompt({
    definition,
    input: data.dependencies.prompts[0]?.input,
    content: data.content,
    dependencies: data.dependencies,
  });
}

function createPromptDependencies(
  root: PromptDependencies["root"],
  input: unknown,
  entries: PromptDependencyEntry[],
): PromptDependencies {
  return {
    root,
    prompts: [
      {
        ...root,
        role: "root",
        input: sanitizeDependencyInput(input),
      },
      ...dedupeDependencyEntries(entries),
    ],
  };
}

function collectDependencyEntries(
  entries: readonly PromptDependencyEntry[],
  parent: string,
): PromptDependencyEntry[] {
  return entries.map((entry) => ({
    ...entry,
    role: "include" as const,
    parent,
  }));
}

function collectMessageDependencies(
  messages: readonly PromptMessage[],
  parent: string,
): PromptDependencyEntry[] {
  return messages.flatMap((message) =>
    collectDependencyEntries(
      (message as PromptMessageWithDependencies)[promptDependencyMarker] ?? [],
      parent,
    ),
  );
}

function collectBuiltPromptDependencies(
  value: unknown,
  parent: string,
): PromptDependencyEntry[] {
  if (isBuiltPrompt(value)) {
    return collectDependencyEntries(value.dependencies.prompts, parent);
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
      type:
        value.kind === "messages"
          ? "built_messages_prompt"
          : "built_string_prompt",
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

function isBuiltPrompt(value: unknown): value is AnyBuiltPrompt {
  return (
    typeof value === "object" && value !== null && builtPromptMarker in value
  );
}

function isBuiltMessagesPrompt(
  value: unknown,
): value is BuiltMessagesPrompt<unknown, unknown> {
  return isBuiltPrompt(value) && value.kind === "messages";
}

function isBuiltStringPrompt(
  value: unknown,
): value is BuiltStringPrompt<unknown, unknown> {
  return isBuiltPrompt(value) && value.kind === "string";
}

function isPromptDefinition(value: unknown): value is AnyPromptDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    promptDefinitionMarker in value
  );
}

function isPromptText(value: unknown): value is PromptText {
  return (
    typeof value === "object" && value !== null && promptTextMarker in value
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
): AnyBuiltPrompt {
  return definition.build(input as never) as AnyBuiltPrompt;
}

function stringSchema<TDomain extends SchemaDomain = "input">(): PromptSchema<
  string,
  string,
  unknown,
  TDomain
> {
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

function numberSchema<TDomain extends SchemaDomain = "input">(): PromptSchema<
  number,
  number,
  unknown,
  TDomain
> {
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

function booleanSchema<TDomain extends SchemaDomain = "input">(): PromptSchema<
  boolean,
  boolean,
  unknown,
  TDomain
> {
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

function enumSchema<
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

function arraySchema<TItemSchema extends InputSchema>(
  item: TItemSchema,
): PromptSchema<
  InferSchema<TItemSchema>[],
  InferInputSchema<TItemSchema>[],
  unknown,
  "input"
> {
  return createArraySchema<TItemSchema, "input">(item);
}

function outputArraySchema<TItemSchema extends OutputSchema>(
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

function objectSchema<TShape extends InputSchemaShape>(
  shape: TShape,
): PromptSchema<
  InferParsedObject<TShape>,
  InferInputObject<TShape>,
  unknown,
  "input"
> {
  return createObjectSchema<TShape, "input">(shape);
}

function outputObjectSchema<TShape extends OutputSchemaShape>(
  shape: TShape,
): PromptSchema<
  InferParsedObject<TShape>,
  InferInputObject<TShape>,
  unknown,
  "output"
> {
  return createObjectSchema<TShape, "output">(shape);
}

function unknownSchema<TDomain extends SchemaDomain = "input">(): PromptSchema<
  unknown,
  unknown,
  unknown,
  TDomain
> {
  return new PromptSchema<unknown, unknown, unknown, TDomain>(
    (value) => value,
    () => ({}),
  );
}

function builtMessagesPromptSchema(): PromptSchema<
  BuiltMessagesPrompt<unknown, unknown>,
  BuiltMessagesPrompt<unknown, unknown>,
  unknown,
  "input"
> {
  return builtPromptSchema("messages");
}

function builtStringPromptSchema(): PromptSchema<
  BuiltStringPrompt<unknown, unknown>,
  BuiltStringPrompt<unknown, unknown>,
  unknown,
  "input"
> {
  return builtPromptSchema("string");
}

function messagesPromptDefinitionSchema<
  TDefinition extends AnyMessagesPromptDefinition,
>(
  definition: TDefinition,
): PromptSchema<
  BuiltMessagesPrompt<ParsedInputOf<TDefinition>, OutputOf<TDefinition>>,
  PromptInputValue<TDefinition, "messages">,
  PromptFieldKind<TDefinition, "messages">,
  "input"
> {
  return promptDefinitionSchema("messages", definition);
}

function stringPromptDefinitionSchema<
  TDefinition extends AnyStringPromptDefinition,
>(
  definition: TDefinition,
): PromptSchema<
  BuiltStringPrompt<ParsedInputOf<TDefinition>, OutputOf<TDefinition>>,
  PromptInputValue<TDefinition, "string">,
  PromptFieldKind<TDefinition, "string">,
  "input"
> {
  return promptDefinitionSchema("string", definition);
}

function builtPromptSchema<TKind extends PromptKind>(
  kind: TKind,
): PromptSchema<
  BuiltPromptForKind<unknown, unknown, TKind>,
  BuiltPromptForKind<unknown, unknown, TKind>,
  unknown,
  "input"
> {
  const label = kind === "messages" ? "messages" : "string";
  return new PromptSchema(
    (value, path) => {
      if (isBuiltPrompt(value)) {
        if (value.kind !== kind) {
          throw new Error(`${path} must be a built ${label} prompt`);
        }
        return value as BuiltPromptForKind<unknown, unknown, TKind>;
      }

      throw new Error(`${path} must be a built ${label} prompt`);
    },
    () => ({
      type: "object",
      "x-bt-type":
        kind === "messages" ? "built_messages_prompt" : "built_string_prompt",
    }),
  );
}

function promptDefinitionSchema<
  TDefinition extends AnyPromptDefinition,
  TKind extends PromptKind,
>(
  kind: TKind,
  definition: TDefinition,
): PromptSchema<
  BuiltPromptForKind<ParsedInputOf<TDefinition>, OutputOf<TDefinition>, TKind>,
  PromptInputValue<TDefinition, TKind>,
  PromptFieldKind<TDefinition, TKind>,
  "input"
> {
  const label = kind === "messages" ? "messages" : "string";
  return new PromptSchema(
    (value, path, root) => {
      if (isBuiltPrompt(value)) {
        if (value.kind !== kind) {
          throw new Error(`${path} must be a built ${label} prompt`);
        }
        return value as BuiltPromptForKind<
          ParsedInputOf<TDefinition>,
          OutputOf<TDefinition>,
          TKind
        >;
      }

      if (
        isPromptDefinition(value) ||
        (isRecord(value) && isPromptDefinition(value.prompt))
      ) {
        throw new Error(
          `${path} must be a built ${label} prompt or prompt input`,
        );
      }

      const built = buildAnyPrompt(definition, mergePromptInputs(root, value));
      if (built.kind !== kind) {
        throw new Error(`${path} must be a built ${label} prompt`);
      }
      return built as BuiltPromptForKind<
        ParsedInputOf<TDefinition>,
        OutputOf<TDefinition>,
        TKind
      >;
    },
    () => ({
      type: "object",
      "x-bt-type":
        kind === "messages" ? "built_messages_prompt" : "built_string_prompt",
    }),
    false,
    { type: "promptDefinition", definition, kind },
  );
}

/**
 * @internal Converts experimental prompt template data into the existing prompt
 * definition shape. This is intended for future backend-saving code paths.
 */
export function promptDefinitionToMustache(
  data: ExperimentalPromptData,
): MustachePromptDefinition {
  if (!data.model) {
    throw new Error("Cannot convert prompt data to mustache without a model");
  }

  if (data.kind === "messages") {
    return {
      model: data.model,
      messages: data.messages,
    };
  }

  return {
    model: data.model,
    messages: [{ role: "user", content: data.content }],
  };
}

const inputSchemaHelpers = {
  string: stringSchema,
  number: numberSchema,
  boolean: booleanSchema,
  enum: enumSchema,
  array: arraySchema,
  object: objectSchema,
  unknown: unknownSchema,
  builtMessagesPrompt: builtMessagesPromptSchema,
  builtStringPrompt: builtStringPromptSchema,
  messagesPromptDefinition: messagesPromptDefinitionSchema,
  stringPromptDefinition: stringPromptDefinitionSchema,
};

const outputSchemaHelpers = {
  string: () => stringSchema<"output">(),
  number: () => numberSchema<"output">(),
  boolean: () => booleanSchema<"output">(),
  enum: <const TValues extends readonly [string, ...string[]]>(
    values: TValues,
  ) => enumSchema<TValues, "output">(values),
  array: outputArraySchema,
  object: outputObjectSchema,
  unknown: () => unknownSchema<"output">(),
};

export const prompt = {
  define: definePrompt,
  system: messageTag("system"),
  user: messageTag("user"),
  assistant: messageTag("assistant"),
  text: textTag,
  isBuiltPrompt,
  isPromptDefinition,
  adapters,
};
