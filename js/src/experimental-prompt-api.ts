import { adapters } from "./experimental-prompt-adapters";
import {
  PromptSchema,
  arraySchema,
  booleanSchema,
  enumSchema,
  numberSchema,
  objectSchema,
  outputArraySchema,
  outputObjectSchema,
  stringSchema,
  unknownSchema,
} from "./experimental-prompt-api-schema-utils";
import { BaseAttachment, ReadonlyAttachment } from "./logger";
import type { AttachmentReferenceType as AttachmentReference } from "./generated_types";
import type {
  InferInputSchema,
  InferSchema,
  InputSchema,
  OutputSchema,
  PromptFieldKind as SchemaPromptFieldKind,
  PromptJsonSchema,
  PromptKind,
  SchemaShape,
} from "./experimental-prompt-api-schema-utils";

export type { PromptJsonSchema } from "./experimental-prompt-api-schema-utils";
export { promptDefinitionToMustache } from "./template-generators/mustache";

const builtPromptMarker = Symbol("braintrust.experimental_prompt.built");
const promptDefinitionMarker = Symbol(
  "braintrust.experimental_prompt.definition",
);
const promptTextMarker = Symbol("braintrust.experimental_prompt.text");
const promptFileMarker = Symbol("braintrust.experimental_prompt.file");
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

export type InlineAttachmentReference = {
  type: "inline_attachment";
  src: string;
  content_type?: string;
  filename?: string;
  data?: string;
};

export type PromptAttachment =
  | string
  | Blob
  | ArrayBuffer
  | ArrayBufferView
  | BaseAttachment
  | ReadonlyAttachment
  | AttachmentReference
  | InlineAttachmentReference;

type PromptFileOptions = {
  filename?: string;
  contentType?: string;
  detail?: "auto" | "low" | "high";
};

export type PromptTextContentPart = {
  type: "text";
  text: string;
};

export type PromptFileContentPart = {
  readonly [promptFileMarker]: true;
  type: "file";
  file: {
    value: unknown;
    filename?: string;
    contentType?: string;
    detail?: "auto" | "low" | "high";
  };
};

export type PromptMessageContentPart =
  | PromptTextContentPart
  | PromptFileContentPart;

type PromptUserContentPartInput =
  | string
  | PromptText
  | PromptTextContentPart
  | PromptFileContentPart;

export type PromptMessage = {
  role: PromptRole;
  content: string | PromptMessageContentPart[];
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

type PromptTemplateResult = readonly PromptMessage[] | PromptText;

type PromptTemplateContext<TVariables> = {
  variables: TVariables;
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

type PromptTemplateField<TValue> = unknown extends TValue
  ? unknown
  : NonNullable<TValue> extends AnyBuiltPrompt
    ? NonNullable<TValue>
    : NonNullable<TValue> extends readonly (infer TItem)[]
      ? unknown & { list: PromptListTag & PromptTemplateField<TItem> }
      : NonNullable<TValue> extends object
        ? unknown & {
            [K in keyof NonNullable<TValue>]-?: PromptTemplateField<
              NonNullable<TValue>[K]
            >;
          }
        : unknown;

type TemplateRenderContext = {
  sectionPath?: string;
  item?: unknown;
};

type InputSchemaHelpers = typeof inputSchemaHelpers;
type OutputSchemaHelpers = typeof outputSchemaHelpers;

type PromptDefinitionOptions<
  TInputSchema extends InputSchema,
  TOutputSchema extends OutputSchema | undefined,
  TTemplateResult extends PromptTemplateResult,
> = {
  id?: string;
  slug: string;
  name?: string;
  version?: string;
  model?: string;
  inputSchema: (s: InputSchemaHelpers) => TInputSchema;
  outputSchema?: (s: OutputSchemaHelpers) => TOutputSchema;
  template: (
    context: PromptTemplateContext<
      PromptTemplateField<InferSchema<TInputSchema>>
    >,
  ) => TTemplateResult;
};

class PromptDefinition<
  TInputSchema extends InputSchema,
  TOutputSchema extends OutputSchema | undefined,
  TTemplateResult extends PromptTemplateResult,
> {
  readonly [promptDefinitionMarker] = true;
  readonly id?: string;
  readonly slug: string;
  readonly name?: string;
  readonly version?: string;
  readonly model?: string;
  readonly inputSchema: TInputSchema;
  readonly outputSchema?: TOutputSchema;

  private readonly template: PromptDefinitionOptions<
    TInputSchema,
    TOutputSchema,
    TTemplateResult
  >["template"];

  constructor(
    opts: PromptDefinitionOptions<TInputSchema, TOutputSchema, TTemplateResult>,
  ) {
    this.id = opts.id;
    this.slug = opts.slug;
    this.name = opts.name;
    this.version = opts.version;
    this.model = opts.model;
    this.inputSchema = opts.inputSchema(inputSchemaHelpers);
    this.outputSchema = opts.outputSchema?.(outputSchemaHelpers);
    this.template = opts.template;
  }

  build(
    input: InferInputSchema<TInputSchema>,
  ): BuiltPromptForTemplateResult<
    InferSchema<TInputSchema>,
    InferOutput<TOutputSchema>,
    TTemplateResult
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
    const rendered = this.template({
      variables,
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
      const dependencies = createPromptDependencies(
        root,
        parsedInput,
        [
          ...collectBuiltPromptDependencies(parsedInput, this.slug),
          ...collectDependencyEntries(rendered.dependencies, this.slug),
        ],
        this.inputSchema,
      );

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
      }) as BuiltPromptForTemplateResult<
        InferSchema<TInputSchema>,
        InferOutput<TOutputSchema>,
        TTemplateResult
      >;
    }

    if (!Array.isArray(rendered)) {
      throw new Error("template must return a message array or prompt.text");
    }

    const messages = rendered.map((message, index) =>
      assertPromptMessage(message, `template[${index}]`),
    );
    const dependencies = createPromptDependencies(
      root,
      parsedInput,
      [
        ...collectBuiltPromptDependencies(parsedInput, this.slug),
        ...collectMessageDependencies(messages, this.slug),
      ],
      this.inputSchema,
    );

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
    }) as BuiltPromptForTemplateResult<
      InferSchema<TInputSchema>,
      InferOutput<TOutputSchema>,
      TTemplateResult
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
    const rendered = this.template({
      variables,
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
      throw new Error("template must return a message array or prompt.text");
    }

    const messages = rendered.map((message, index) =>
      assertPromptMessage(message, `template[${index}]`),
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
  PromptTemplateResult
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
    PromptTemplateResult
  >
    ? InferInputSchema<TInputSchema>
    : never;

type ParsedInputOf<TDefinition> =
  TDefinition extends PromptDefinition<
    infer TInputSchema,
    OutputSchema | undefined,
    PromptTemplateResult
  >
    ? InferSchema<TInputSchema>
    : never;

type OutputOf<TDefinition> =
  TDefinition extends PromptDefinition<
    InputSchema,
    infer TOutputSchema,
    PromptTemplateResult
  >
    ? InferOutput<TOutputSchema>
    : never;

type BuiltPromptOf<TDefinition> =
  TDefinition extends PromptDefinition<
    infer TInputSchema,
    infer TOutputSchema,
    infer TTemplateResult
  >
    ? BuiltPromptForTemplateResult<
        InferSchema<TInputSchema>,
        InferOutput<TOutputSchema>,
        TTemplateResult
      >
    : never;

type BuiltPromptForTemplateResult<TInput, TOutput, TTemplateResult> =
  TTemplateResult extends PromptText
    ? BuiltStringPrompt<TInput, TOutput>
    : TTemplateResult extends readonly PromptMessage[]
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
> = SchemaPromptFieldKind<
  BuiltPromptForKind<
    ParsedInputOf<TDefinition>,
    OutputOf<TDefinition>,
    TPromptKind
  >,
  InputOf<TDefinition>,
  TPromptKind
>;

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
type MaybePromise<T> = T | Promise<T>;

type Extendable<T extends PromptAdapterResult> = T & {
  extend<TExtension extends PromptExtension>(
    extension: TExtension,
  ): Extendable<DeepMerge<T, TExtension>>;
};

type SyncPromptAdapter<TInput, TOutput, TResult extends PromptAdapterResult> = (
  builtPrompt: PromptAdapterInput<TInput, TOutput>,
) => TResult;

type AsyncPromptAdapter<
  TInput,
  TOutput,
  TResult extends PromptAdapterResult,
> = (builtPrompt: PromptAdapterInput<TInput, TOutput>) => Promise<TResult>;

type PromptAdapter<TInput, TOutput, TResult extends PromptAdapterResult> =
  | SyncPromptAdapter<TInput, TOutput, TResult>
  | AsyncPromptAdapter<TInput, TOutput, TResult>;

type MaybeAsyncPromptAdapterResult<TResult extends PromptAdapterResult> =
  | Extendable<TResult>
  | Promise<Extendable<TResult>>;

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
    adapter: AsyncPromptAdapter<TInput, TOutput, TResult>,
  ): Promise<Extendable<TResult>>;
  to<TResult extends PromptAdapterResult>(
    adapter: SyncPromptAdapter<TInput, TOutput, TResult>,
  ): Extendable<TResult>;
  to<TResult extends PromptAdapterResult>(
    adapter: PromptAdapter<TInput, TOutput, TResult>,
  ): MaybeAsyncPromptAdapterResult<TResult> {
    const result = adapter({
      kind: "messages",
      model: this.definition.model,
      inputSchema: this.definition.inputSchema,
      outputSchema: this.definition.outputSchema,
      input: this.input,
      messages: this.messages,
      dependencies: this.dependencies,
    });
    return isPromiseLike(result)
      ? result.then((resolved) => makeExtendableAdapterResult(resolved))
      : makeExtendableAdapterResult(result);
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
    adapter: AsyncPromptAdapter<TInput, TOutput, TResult>,
  ): Promise<Extendable<TResult>>;
  to<TResult extends PromptAdapterResult>(
    adapter: SyncPromptAdapter<TInput, TOutput, TResult>,
  ): Extendable<TResult>;
  to<TResult extends PromptAdapterResult>(
    adapter: PromptAdapter<TInput, TOutput, TResult>,
  ): MaybeAsyncPromptAdapterResult<TResult> {
    const result = adapter({
      kind: "string",
      model: this.definition.model,
      inputSchema: this.definition.inputSchema,
      outputSchema: this.definition.outputSchema,
      input: this.input,
      content: this.content,
      messages: [{ role: "user", content: this.content }],
      dependencies: this.dependencies,
    });
    return isPromiseLike(result)
      ? result.then((resolved) => makeExtendableAdapterResult(resolved))
      : makeExtendableAdapterResult(result);
  }
}

function isPromiseLike<T>(value: MaybePromise<T>): value is Promise<T> {
  return isRecord(value) && typeof value.then === "function";
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
  TTemplateResult extends PromptTemplateResult = PromptTemplateResult,
>(
  opts: PromptDefinitionOptions<TInputSchema, TOutputSchema, TTemplateResult>,
): PromptDefinition<TInputSchema, TOutputSchema, TTemplateResult> {
  return new PromptDefinition(opts);
}

type PromptMessageTag = (
  strings: TemplateStringsArray,
  ...values: readonly unknown[]
) => PromptMessage;

type PromptUserMessageTag = PromptMessageTag & {
  (content: readonly PromptUserContentPartInput[]): PromptMessage;
};

function messageTag(role: "system" | "assistant"): PromptMessageTag;
function messageTag(role: "user"): PromptUserMessageTag;
function messageTag(role: PromptRole): PromptMessageTag | PromptUserMessageTag {
  return ((
    stringsOrContent:
      | TemplateStringsArray
      | readonly PromptUserContentPartInput[],
    ...values: readonly unknown[]
  ): PromptMessage => {
    if (!isTemplateStringsArray(stringsOrContent)) {
      if (role !== "user") {
        throw new Error(
          "rich prompt content is only supported for user messages",
        );
      }
      return userMessageFromContentParts(stringsOrContent);
    }

    const rendered = renderTaggedTemplate(stringsOrContent, values);
    return attachDependenciesToMessage(
      { role, content: rendered.content },
      rendered.dependencies,
    );
  }) as PromptMessageTag | PromptUserMessageTag;
}

function userMessageFromContentParts(
  parts: readonly PromptUserContentPartInput[],
): PromptMessage {
  const dependencies: PromptDependencyEntry[] = [];
  const content = parts.map((part, index): PromptMessageContentPart => {
    if (typeof part === "string") {
      return { type: "text", text: part };
    }
    if (isPromptText(part)) {
      dependencies.push(...part.dependencies);
      return { type: "text", text: part.content };
    }
    if (isPromptFileContentPart(part)) {
      return part;
    }
    if (
      isRecord(part) &&
      part.type === "text" &&
      typeof part.text === "string"
    ) {
      return { type: "text", text: part.text };
    }

    throw new Error(
      `user content part ${index} must be prompt.text or prompt.file`,
    );
  });
  return attachDependenciesToMessage({ role: "user", content }, dependencies);
}

function filePart(
  value: unknown,
  options: PromptFileOptions = {},
): PromptFileContentPart {
  return {
    [promptFileMarker]: true,
    type: "file",
    file: {
      value,
      filename: options.filename,
      contentType: options.contentType,
      detail: options.detail,
    },
  };
}

function isTemplateStringsArray(value: unknown): value is TemplateStringsArray {
  return (
    Array.isArray(value) && Array.isArray((value as { raw?: unknown }).raw)
  );
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
    !isPromptMessageContent(value.role, value.content)
  ) {
    throw new Error(`${path} must be a prompt message`);
  }
  return value as PromptMessage;
}

function isPromptMessageContent(role: unknown, content: unknown): boolean {
  if (typeof content === "string") {
    return true;
  }
  if (!Array.isArray(content)) {
    return false;
  }
  if (role !== "user") {
    return false;
  }
  return content.every(isPromptMessageContentPart);
}

function isPromptMessageContentPart(
  value: unknown,
): value is PromptMessageContentPart {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }
  if (value.type === "text") {
    return typeof value.text === "string";
  }
  return isPromptFileContentPart(value);
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
      : nestedPromptBuilder(
          templateInfo.definition as AnyPromptDefinition,
          templateInfo.kind,
          path,
        );
  }

  if (templateInfo?.type === "attachment") {
    return mode === "runtime"
      ? runtimeValue
      : createPromptVariableValue({
          path,
          mode,
          runtimeValue,
          sectionPath,
          relativePath,
        });
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
      root: promptDefinitionRoot(
        templateInfo.definition as AnyPromptDefinition,
      ),
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
  inputSchema?: InputSchema,
): PromptDependencies {
  return {
    root,
    prompts: [
      {
        ...root,
        role: "root",
        input: sanitizeDependencyInput(input, inputSchema),
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
  if (isPromptAttachmentValue(value) || isPromptFileContentPart(value)) {
    return [];
  }
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

function sanitizeDependencyInput(
  value: unknown,
  schema?: InputSchema,
): unknown {
  const templateInfo = schema?.templateInfo;
  if (templateInfo?.type === "attachment") {
    return summarizeAttachmentInput(value);
  }
  if (templateInfo?.type === "object" && isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sanitizeDependencyInput(item, templateInfo.shape[key] as InputSchema),
      ]),
    );
  }
  if (templateInfo?.type === "array" && Array.isArray(value)) {
    return value.map((item) =>
      sanitizeDependencyInput(item, templateInfo.item as InputSchema),
    );
  }
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
  if (isPromptFileContentPart(value)) {
    return {
      type: "prompt_file",
      file: summarizeAttachmentInput(value.file.value),
      filename: value.file.filename,
      content_type: value.file.contentType,
    };
  }
  if (isPromptAttachmentValue(value)) {
    return summarizeAttachmentInput(value);
  }
  if (typeof value === "string" && value.startsWith("data:")) {
    return summarizeStringAttachment(value);
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

function summarizeAttachmentInput(value: unknown): unknown {
  if (value instanceof BaseAttachment || value instanceof ReadonlyAttachment) {
    return {
      type: "attachment",
      reference: value.reference,
    };
  }
  if (isAttachmentReference(value)) {
    return value;
  }
  if (isInlineAttachmentReference(value)) {
    return {
      type: "inline_attachment",
      content_type: value.content_type,
      filename: value.filename,
      src: summarizeStringAttachment(value.src),
    };
  }
  if (isBlob(value)) {
    return {
      type: "blob",
      content_type: value.type || undefined,
      byte_length: value.size,
    };
  }
  if (value instanceof ArrayBuffer) {
    return { type: "array_buffer", byte_length: value.byteLength };
  }
  if (ArrayBuffer.isView(value)) {
    return {
      type: "binary",
      byte_length: value.byteLength,
    };
  }
  if (typeof value === "string") {
    return summarizeStringAttachment(value);
  }
  return { type: "attachment", value_type: typeof value };
}

function summarizeStringAttachment(value: string): unknown {
  if (value.startsWith("data:")) {
    return {
      type: "data_url",
      content_type: dataUrlContentType(value),
      byte_length: value.length,
    };
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

function isPromptFileContentPart(
  value: unknown,
): value is PromptFileContentPart {
  return (
    typeof value === "object" && value !== null && promptFileMarker in value
  );
}

function isPromptAttachmentValue(value: unknown): value is PromptAttachment {
  return (
    typeof value === "string" ||
    isBlob(value) ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    value instanceof BaseAttachment ||
    value instanceof ReadonlyAttachment ||
    isAttachmentReference(value) ||
    isInlineAttachmentReference(value)
  );
}

function isBlob(value: unknown): value is Blob {
  return typeof Blob !== "undefined" && value instanceof Blob;
}

function isAttachmentReference(value: unknown): value is AttachmentReference {
  return (
    isRecord(value) &&
    ((value.type === "braintrust_attachment" &&
      typeof value.key === "string" &&
      typeof value.filename === "string" &&
      typeof value.content_type === "string") ||
      (value.type === "external_attachment" &&
        typeof value.url === "string" &&
        typeof value.filename === "string" &&
        typeof value.content_type === "string"))
  );
}

function isInlineAttachmentReference(
  value: unknown,
): value is InlineAttachmentReference {
  return (
    isRecord(value) &&
    value.type === "inline_attachment" &&
    typeof value.src === "string" &&
    (value.content_type === undefined ||
      typeof value.content_type === "string") &&
    (value.filename === undefined || typeof value.filename === "string") &&
    (value.data === undefined || typeof value.data === "string")
  );
}

function dataUrlContentType(value: string): string | undefined {
  return value.match(/^data:([^;,]+)[;,]/)?.[1];
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

function attachmentSchema(): PromptSchema<
  PromptAttachment,
  PromptAttachment,
  unknown,
  "input"
> {
  return new PromptSchema<PromptAttachment, PromptAttachment, unknown, "input">(
    (value, path) => {
      if (!isPromptAttachmentValue(value)) {
        throw new Error(`${path} must be an attachment`);
      }
      return value;
    },
    () => ({ "x-bt-type": "attachment" }),
    false,
    { type: "attachment" },
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

const inputSchemaHelpers = {
  string: stringSchema,
  number: numberSchema,
  boolean: booleanSchema,
  enum: enumSchema,
  array: arraySchema,
  object: objectSchema,
  unknown: unknownSchema,
  attachment: attachmentSchema,
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
  file: filePart,
  isBuiltPrompt,
  isPromptDefinition,
  adapters,
};
