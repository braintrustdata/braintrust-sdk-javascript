import { _initializeSpanContext } from "./framework";
import type { Trace } from "./trace";
import iso from "./isomorph";
import { slugify } from "../util/string_util";
import { z } from "zod/v3";
import {
  type FunctionTypeEnumType as FunctionType,
  type IfExistsType as IfExists,
  type SavedFunctionIdType as SavedFunctionId,
  type PromptBlockDataType as PromptBlockData,
  type PromptDataType as PromptData,
  ToolFunctionDefinition as toolFunctionDefinitionSchema,
  type ToolFunctionDefinitionType as ToolFunctionDefinition,
  FunctionData as functionDataSchema,
  Project as projectSchema,
  type ExtendedSavedFunctionIdType as ExtendedSavedFunctionId,
} from "./generated_types";
import { loadPrettyXact, TransactionId } from "../util/index";
import {
  _internalGetGlobalState,
  login,
  Prompt,
  PromptRowWithId,
  RemoteEvalParameters,
} from "./logger";
import type { BaseFnOpts, GenericFunction } from "./framework-types";
import type { EvalParameters } from "./eval-parameters";
import {
  promptDefinitionToPromptData,
  type PromptDefinition,
} from "./prompt-schemas";
import { zodToJsonSchema } from "./zod/utils";
import type {
  ParametersSchema,
  StaticParametersSchema,
  SerializedParametersContainer,
} from "../dev/types";

export { toolFunctionDefinitionSchema };
// ToolFunctionDefinition exported as type-only from main index to avoid namespace issues

// Safe access to __filename (only exists in Node.js CJS)
const currentFilename =
  typeof __filename !== "undefined" ? __filename : "unknown";

type NameOrId = { name: string } | { id: string };

export type CreateProjectOpts = NameOrId;
class ProjectBuilder {
  create(opts: CreateProjectOpts) {
    return new Project(opts);
  }
}
export const projects = new ProjectBuilder();

export class Project {
  public readonly name?: string;
  public readonly id?: string;
  public tools: ToolBuilder;
  public prompts: PromptBuilder;
  public parameters: ParametersBuilder;
  public scorers: ScorerBuilder;

  private _publishableCodeFunctions: CodeFunction<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    GenericFunction<any, any>
  >[] = [];
  private _publishablePrompts: CodePrompt[] = [];
  private _publishableParameters: CodeParameters[] = [];

  constructor(args: CreateProjectOpts) {
    _initializeSpanContext();
    this.name = "name" in args ? args.name : undefined;
    this.id = "id" in args ? args.id : undefined;
    this.tools = new ToolBuilder(this);
    this.prompts = new PromptBuilder(this);
    this.parameters = new ParametersBuilder(this);
    this.scorers = new ScorerBuilder(this);
  }

  public addPrompt(prompt: CodePrompt) {
    this._publishablePrompts.push(prompt);
    if (globalThis._lazy_load) {
      globalThis._evals.prompts.push(prompt);
    }
  }

  public addParameters(parameters: CodeParameters) {
    this._publishableParameters.push(parameters);
    if (globalThis._lazy_load) {
      if (globalThis._evals.parameters == null)
        globalThis._evals.parameters = [];

      globalThis._evals.parameters.push(parameters);
    }
  }

  public addCodeFunction(
    fn: CodeFunction<
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      GenericFunction<any, any>
    >,
  ) {
    this._publishableCodeFunctions.push(fn);
    if (globalThis._lazy_load) {
      globalThis._evals.functions.push(fn);
    }
  }

  async publish() {
    if (globalThis._lazy_load) {
      // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
      console.warn("publish() is a no-op when running `braintrust push`.");
      return;
    }
    await login();
    const projectMap = new ProjectNameIdMap();
    const functionDefinitions: FunctionEvent[] = [];
    if (this._publishableCodeFunctions.length > 0) {
      // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
      console.warn(
        "Code functions cannot be published directly. Use `braintrust push` instead.",
      );
    }
    if (this._publishablePrompts.length > 0) {
      for (const prompt of this._publishablePrompts) {
        const functionDefinition =
          await prompt.toFunctionDefinition(projectMap);
        functionDefinitions.push(functionDefinition);
      }
    }

    await _internalGetGlobalState().apiConn().post_json("insert-functions", {
      functions: functionDefinitions,
    });
  }
}

export class ToolBuilder {
  private taskCounter = 0;
  constructor(private readonly project: Project) {}

  public create<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    TParams extends { _output: any; _input: any; _def: any },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    TReturns extends { _output: any; _input: any; _def: any },
    THandler extends GenericFunction<TParams["_output"], TReturns["_output"]>,
  >(
    opts: Partial<BaseFnOpts> & {
      handler: THandler;
      parameters: TParams;
      returns: TReturns;
    },
  ): CodeFunction<TParams["_output"], TReturns["_output"], THandler>;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public create<THandler extends GenericFunction<any, any>>(
    opts: Partial<BaseFnOpts> & {
      handler: THandler;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parameters?: any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      returns?: any;
    }, // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): CodeFunction<any, any, THandler>;

  // This type definition is just a catch all so that the implementation can be
  // less specific than the two more specific declarations above.
  public create(
    opts: Partial<BaseFnOpts> & {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: GenericFunction<any, any>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parameters?: any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      returns?: any;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): CodeFunction<any, any, any> {
    this.taskCounter++;
    opts = opts ?? {};

    const { handler, name, slug, parameters, returns, ...rest } = opts;
    let resolvedName = name ?? handler.name;

    if (resolvedName.trim().length === 0) {
      resolvedName = `Tool ${iso.basename(currentFilename)} ${this.taskCounter}`;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tool: CodeFunction<any, any, any> = new CodeFunction(this.project, {
      handler,
      name: resolvedName,
      slug: slug ?? slugify(resolvedName, { lower: true, strict: true }),
      type: "tool",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions
      parameters: parameters as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions
      returns: returns as any,
      ...rest,
    });

    this.project.addCodeFunction(tool);
    return tool;
  }
}

export class ScorerBuilder {
  private taskCounter = 0;
  constructor(private readonly project: Project) {}

  public create<
    Output,
    Input,
    Params,
    Returns,
    Fn extends GenericFunction<
      Exact<Params, ScorerArgs<Output, Input>>,
      Returns
    >,
  >(opts: ScorerOpts<Output, Input, Params, Returns, Fn>) {
    this.taskCounter++;

    let resolvedName = opts.name;
    if (!resolvedName && "handler" in opts) {
      resolvedName = opts.handler.name;
    }
    if (!resolvedName || resolvedName.trim().length === 0) {
      resolvedName = `Scorer ${iso.basename(currentFilename)} ${this.taskCounter}`;
    }
    const slug =
      opts.slug ?? slugify(resolvedName, { lower: true, strict: true });

    if ("handler" in opts) {
      const scorer: CodeFunction<
        Exact<Params, ScorerArgs<Output, Input>>,
        Returns,
        Fn
      > = new CodeFunction(this.project, {
        ...opts,
        name: resolvedName,
        slug,
        type: "scorer",
      });
      this.project.addCodeFunction(scorer);
    } else {
      const promptBlock: PromptBlockData =
        "messages" in opts
          ? {
              type: "chat",
              messages: opts.messages,
            }
          : {
              type: "completion",
              content: opts.prompt,
            };
      const promptData: PromptData = {
        prompt: promptBlock,
        options: {
          model: opts.model,
          params: opts.params,
        },
        parser: {
          type: "llm_classifier",
          use_cot: opts.useCot,
          choice_scores: opts.choiceScores,
        },
      };
      const codePrompt = new CodePrompt(
        this.project,
        promptData,
        [],
        {
          ...opts,
          name: resolvedName,
          slug,
        },
        "scorer",
      );
      this.project.addPrompt(codePrompt);
    }
  }
}

type Schema<Input, Output> = Partial<{
  parameters: z.ZodSchema<Input>;
  returns: z.ZodSchema<Output>;
}>;

export type CodeOpts<
  Params,
  Returns,
  Fn extends GenericFunction<Params, Returns>,
> = Partial<BaseFnOpts> & {
  handler: Fn;
  metadata?: Record<string, unknown>;
} & Schema<Params, Returns>;

type ScorerPromptOpts = Partial<BaseFnOpts> &
  PromptOpts<false, false, false, false> & {
    useCot: boolean;
    choiceScores: Record<string, number>;
    metadata?: Record<string, unknown>;
  };

// A more correct ScorerArgs than that in core/js/src/score.ts.
type ScorerArgs<Output, Input> = {
  output: Output;
  expected?: Output;
  input?: Input;
  metadata?: Record<string, unknown>;
  trace?: Trace;
};

type Exact<T, Shape> = T extends Shape
  ? Exclude<keyof T, keyof Shape> extends never
    ? T
    : never
  : never;

type ScorerOptsUnion<
  Output,
  Input,
  Params,
  Returns,
  Fn extends GenericFunction<Exact<Params, ScorerArgs<Output, Input>>, Returns>,
> =
  | CodeOpts<Exact<Params, ScorerArgs<Output, Input>>, Returns, Fn>
  | ScorerPromptOpts;

export type ScorerOpts<
  Output,
  Input,
  Params,
  Returns,
  Fn extends GenericFunction<Exact<Params, ScorerArgs<Output, Input>>, Returns>,
> = ScorerOptsUnion<Output, Input, Params, Returns, Fn> & {
  metadata?: Record<string, unknown>;
};

export class CodeFunction<
  Input,
  Output,
  Fn extends GenericFunction<Input, Output>,
> {
  public readonly handler: Fn;
  public readonly name: string;
  public readonly slug: string;
  public readonly type: FunctionType;
  public readonly description?: string;
  public readonly parameters?: z.ZodSchema<Input>;
  public readonly returns?: z.ZodSchema<Output>;
  public readonly ifExists?: IfExists;
  public readonly tags?: string[];
  public readonly metadata?: Record<string, unknown>;

  constructor(
    public readonly project: Project,
    opts: Omit<CodeOpts<Input, Output, Fn>, "name" | "slug"> & {
      name: string;
      slug: string;
      type: FunctionType;
    },
  ) {
    this.handler = opts.handler;

    this.name = opts.name;
    this.slug = opts.slug;
    this.description = opts.description;
    this.type = opts.type;

    this.ifExists = opts.ifExists;
    this.tags = opts.tags;
    this.metadata = opts.metadata;

    this.parameters = opts.parameters;
    this.returns = opts.returns;

    if (this.returns && !this.parameters) {
      throw new Error("parameters are required if return type is defined");
    }
  }

  public key(): string {
    return JSON.stringify([
      this.project.id ?? "",
      this.project.name ?? "",
      this.slug,
    ]);
  }
}

type GenericCodeFunction = CodeFunction<
  // This has to be marked as any because we want to support arrays of
  // functions that return different things.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  GenericFunction<any, any>
>;

export class CodePrompt {
  public readonly project: Project;
  public readonly name: string;
  public readonly slug: string;
  public readonly prompt: PromptData;
  public readonly ifExists?: IfExists;
  public readonly description?: string;
  public readonly id?: string;
  public readonly functionType?: FunctionType;
  public readonly toolFunctions: (SavedFunctionId | GenericCodeFunction)[];
  public readonly tags?: string[];
  public readonly metadata?: Record<string, unknown>;
  public readonly environmentSlugs?: string[];

  constructor(
    project: Project,
    prompt: PromptData,
    toolFunctions: (SavedFunctionId | GenericCodeFunction)[],
    opts: Omit<PromptOpts<false, false, false, false>, "name" | "slug"> & {
      name: string;
      slug: string;
    },
    functionType?: FunctionType,
  ) {
    this.project = project;
    this.name = opts.name;
    this.slug = opts.slug;
    this.prompt = prompt;
    this.toolFunctions = toolFunctions;
    this.ifExists = opts.ifExists;
    this.description = opts.description;
    this.id = opts.id;
    this.functionType = functionType;
    this.tags = opts.tags;
    this.metadata = opts.metadata;
    this.environmentSlugs = opts.environments;
  }

  async toFunctionDefinition(
    projectNameToId: ProjectNameIdMap,
  ): Promise<FunctionEvent> {
    const prompt_data = {
      ...this.prompt,
    };
    if (this.toolFunctions.length > 0) {
      const resolvableToolFunctions: ExtendedSavedFunctionId[] =
        await Promise.all(
          this.toolFunctions.map(async (fn) => {
            if ("slug" in fn) {
              return {
                type: "slug",
                project_id: await projectNameToId.resolve(fn.project),
                slug: fn.slug,
              };
            } else {
              return fn;
            }
          }),
        );

      // This is a hack because these will be resolved on the server side.
      prompt_data.tool_functions =
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
        resolvableToolFunctions as SavedFunctionId[];
    }
    return {
      project_id: await projectNameToId.resolve(this.project),
      name: this.name,
      slug: this.slug,
      description: this.description ?? "",
      function_data: {
        type: "prompt",
      },
      function_type: this.functionType,
      prompt_data,
      if_exists: this.ifExists,
      tags: this.tags,
      metadata: this.metadata,
      environments:
        this.environmentSlugs && this.environmentSlugs.length > 0
          ? this.environmentSlugs.map((slug) => ({ slug }))
          : undefined,
    };
  }
}

interface PromptId {
  id: string;
}

interface PromptVersion {
  version: TransactionId;
}

interface PromptTools {
  tools: (GenericCodeFunction | SavedFunctionId | ToolFunctionDefinition)[];
}

interface PromptNoTrace {
  noTrace: boolean;
}

export type PromptOpts<
  HasId extends boolean,
  HasVersion extends boolean,
  HasTools extends boolean = true,
  HasNoTrace extends boolean = true,
> = (Partial<Omit<BaseFnOpts, "name">> & { name: string }) &
  (HasId extends true ? PromptId : Partial<PromptId>) &
  (HasVersion extends true ? PromptVersion : Partial<PromptVersion>) &
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  (HasTools extends true ? Partial<PromptTools> : {}) &
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  (HasNoTrace extends true ? Partial<PromptNoTrace> : {}) &
  PromptDefinition;

export class PromptBuilder {
  constructor(private readonly project: Project) {}

  public create<
    HasId extends boolean = false,
    HasVersion extends boolean = false,
  >(opts: PromptOpts<HasId, HasVersion>): Prompt<HasId, HasVersion> {
    const toolFunctions: (SavedFunctionId | GenericCodeFunction)[] = [];
    const rawTools: ToolFunctionDefinition[] = [];

    for (const tool of opts.tools ?? []) {
      if (tool instanceof CodeFunction) {
        toolFunctions.push(tool);
      } else if ("type" in tool && !("function" in tool)) {
        toolFunctions.push(tool);
      } else {
        rawTools.push(tool);
      }
    }

    const slug = opts.slug ?? slugify(opts.name, { lower: true, strict: true });

    const promptData: PromptData = promptDefinitionToPromptData(opts, rawTools);

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const promptRow: PromptRowWithId<HasId, HasVersion> = {
      id: opts.id,
      _xact_id: opts.version ? loadPrettyXact(opts.version) : undefined,
      name: opts.name,
      slug: slug,
      prompt_data: promptData,
      tags: opts.tags,
      ...(this.project.id !== undefined ? { project_id: this.project.id } : {}),
    } as PromptRowWithId<HasId, HasVersion>;

    const prompt = new Prompt<HasId, HasVersion>(
      promptRow,
      {}, // It doesn't make sense to specify defaults here.
      opts.noTrace ?? false,
    );

    const codePrompt = new CodePrompt(this.project, promptData, toolFunctions, {
      ...opts,
      slug,
    });
    this.project.addPrompt(codePrompt);

    return prompt;
  }
}

export interface ParametersOpts<S extends EvalParameters> {
  name: string;
  slug?: string;
  description?: string;
  schema: S;
  ifExists?: IfExists;
  metadata?: Record<string, unknown>;
}

export class CodeParameters {
  public readonly project: Project;
  public readonly name: string;
  public readonly slug: string;
  public readonly description?: string;
  public readonly schema: EvalParameters;
  public readonly ifExists?: IfExists;
  public readonly metadata?: Record<string, unknown>;

  constructor(
    project: Project,
    opts: {
      name: string;
      slug: string;
      description?: string;
      schema: EvalParameters;
      ifExists?: IfExists;
      metadata?: Record<string, unknown>;
    },
  ) {
    this.project = project;
    this.name = opts.name;
    this.slug = opts.slug;
    this.description = opts.description;
    this.schema = opts.schema;
    this.ifExists = opts.ifExists;
    this.metadata = opts.metadata;
  }

  async toFunctionDefinition(
    projectNameToId: ProjectNameIdMap,
  ): Promise<FunctionEvent> {
    const schema = serializeEvalParameterstoParametersSchema(this.schema);
    return {
      project_id: await projectNameToId.resolve(this.project),
      name: this.name,
      slug: this.slug,
      description: this.description ?? "",
      function_type: "parameters",
      function_data: {
        type: "parameters",
        data: getDefaultDataFromParametersSchema(schema),
        __schema: schema,
      },
      if_exists: this.ifExists,
      metadata: this.metadata,
    };
  }
}

class ParametersBuilder {
  constructor(private readonly project: Project) {}

  public create<S extends EvalParameters>(opts: ParametersOpts<S>): S {
    const slug = opts.slug ?? slugify(opts.name, { lower: true, strict: true });

    const codeParameters = new CodeParameters(this.project, {
      name: opts.name,
      slug,
      description: opts.description,
      schema: opts.schema,
      ifExists: opts.ifExists,
      metadata: opts.metadata,
    });

    this.project.addParameters(codeParameters);

    return opts.schema;
  }
}

export function serializeEvalParametersToStaticParametersSchema(
  parameters: EvalParameters,
): StaticParametersSchema {
  return Object.fromEntries(
    Object.entries(parameters).map(([name, value]) => {
      if ("type" in value && value.type === "prompt") {
        return [
          name,
          {
            type: "prompt",
            default: value.default
              ? promptDefinitionToPromptData(value.default)
              : undefined,
            description: value.description,
          },
        ];
      } else if ("type" in value && value.type === "model") {
        return [
          name,
          {
            type: "model",
            default: value.default,
            description: value.description,
          },
        ];
      } else {
        // Since this schema is bundled, it won't pass an instanceof check. For
        // some reason, aliasing it to `z.ZodSchema` leads to `error TS2589:
        // Type instantiation is excessively deep and possibly infinite.` So
        // just using `any` to turn off the typesystem.
        //
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
        const schemaObj = zodToJsonSchema(value as unknown as z.ZodType);
        return [
          name,
          {
            type: "data",
            schema: schemaObj,
            default: schemaObj.default,
            description: schemaObj.description,
          },
        ];
      }
    }),
  );
}

function serializeEvalParameterstoParametersSchema(
  parameters: EvalParameters,
): ParametersSchema {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];

  for (const [name, value] of Object.entries(parameters)) {
    if ("type" in value && value.type === "prompt") {
      const defaultPromptData = value.default
        ? promptDefinitionToPromptData(value.default)
        : undefined;

      properties[name] = {
        type: "object",
        "x-bt-type": "prompt",
        ...(value.description ? { description: value.description } : {}),
        ...(defaultPromptData ? { default: defaultPromptData } : {}),
      };

      if (!defaultPromptData) {
        required.push(name);
      }
    } else if ("type" in value && value.type === "model") {
      properties[name] = {
        type: "string",
        "x-bt-type": "model",
        ...(value.description ? { description: value.description } : {}),
        ...("default" in value ? { default: value.default } : {}),
      };

      if (!("default" in value)) {
        required.push(name);
      }
    } else {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      const schemaObj = zodToJsonSchema(value as z.ZodType) as Record<
        string,
        unknown
      >;

      properties[name] = schemaObj;

      if (!("default" in schemaObj)) {
        required.push(name);
      }
    }
  }

  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: true,
  };
}

function getDefaultDataFromParametersSchema(
  schema: ParametersSchema,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(schema.properties).flatMap(([name, value]) => {
      if (!("default" in value)) {
        return [];
      }

      return [[name, value.default]];
    }),
  );
}

export function serializeRemoteEvalParametersContainer(
  parameters: EvalParameters | RemoteEvalParameters<boolean, boolean>,
): SerializedParametersContainer {
  if (RemoteEvalParameters.isParameters(parameters)) {
    return {
      type: "braintrust.parameters",
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      schema: parameters.schema as ParametersSchema,
      source: {
        parametersId: parameters.id,
        slug: parameters.slug,
        name: parameters.name,
        projectId: parameters.projectId,
        version: parameters.version,
      },
    };
  }

  return {
    type: "braintrust.staticParameters",
    schema: serializeEvalParametersToStaticParametersSchema(parameters),
    source: null,
  };
}

export interface FunctionEvent {
  project_id: string;
  slug: string;
  name: string;
  description: string;
  prompt_data?: PromptData;
  function_data: z.infer<typeof functionDataSchema>;
  function_type?: FunctionType;
  if_exists?: IfExists;
  tags?: string[];
  metadata?: Record<string, unknown>;
  environments?: { slug: string }[];
}

export class ProjectNameIdMap {
  private nameToId: Record<string, string> = {};
  private idToName: Record<string, string> = {};

  async getId(projectName: string): Promise<string> {
    if (!(projectName in this.nameToId)) {
      const response = await _internalGetGlobalState()
        .appConn()
        .post_json("api/project/register", {
          project_name: projectName,
        });

      const result = z
        .object({
          project: projectSchema,
        })
        .parse(response);

      const projectId = result.project.id;

      this.nameToId[projectName] = projectId;
      this.idToName[projectId] = projectName;
    }
    return this.nameToId[projectName];
  }

  async getName(projectId: string): Promise<string> {
    if (!(projectId in this.idToName)) {
      const response = await _internalGetGlobalState()
        .appConn()
        .post_json("api/project/get", {
          id: projectId,
        });
      const result = z.array(projectSchema).nonempty().parse(response);
      const projectName = result[0].name;
      this.idToName[projectId] = projectName;
      this.nameToId[projectName] = projectId;
    }
    return this.idToName[projectId];
  }

  async resolve(project: Project): Promise<string> {
    if (project.id) {
      return project.id;
    }
    return this.getId(project.name!);
  }
}
