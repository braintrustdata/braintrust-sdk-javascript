import { z } from "zod/v3";
import {
  BraintrustAttachmentReference as BraintrustAttachmentReferenceSchema,
  BraintrustModelParams as braintrustModelParamsSchema,
  ChatCompletionTool as chatCompletionToolSchema,
  type ChatCompletionToolType as ChatCompletionTool,
  type ChatCompletionMessageParamType as Message,
  ExternalAttachmentReference as ExternalAttachmentReferenceSchema,
  PromptData as promptDataSchema,
  PromptBlockData as promptBlockDataSchema,
  ResponseFormatJsonSchema as responseFormatJsonSchemaSchema,
} from "../generated_types";
import {
  getObjValueByPath,
  isArray,
  isEmpty,
  isObject,
  TRANSACTION_ID_FIELD,
  type TransactionId,
} from "../util";
import {
  isTemplateFormat,
  parseTemplateFormat,
  renderTemplateContent,
} from "../template/renderer";
import {
  getTemplateRenderer,
  registerTemplatePlugin,
  templateRegistry,
  type TemplateFormat,
  type TemplateRenderer,
  type TemplateRendererPlugin,
} from "../template/registry";

const InlineAttachmentReferenceSchema = z.object({
  type: z.literal("inline_attachment"),
  src: z.string().min(1),
  content_type: z.string().optional(),
  filename: z.string().optional(),
});

const BRAINTRUST_PARAMS = Object.keys(braintrustModelParamsSchema.shape);

type PromptData = z.infer<typeof promptDataSchema>;
type PromptBlockData = z.infer<typeof promptBlockDataSchema>;
type PromptSpanInfo = {
  name?: string;
  spanAttributes?: Record<string, unknown>;
  metadata: {
    prompt:
      | {
          variables: Record<string, unknown>;
          id: string;
          project_id: string;
          version: string;
          prompt_session_id?: string;
        }
      | undefined;
  };
};

export type CompiledPromptParams = Record<string, unknown> & {
  model: string;
  reasoning_effort?: string;
  response_format?: unknown;
};

export type ChatPrompt = {
  messages: Message[];
  tools?: ChatCompletionTool[];
};

export type CompletionPrompt = {
  prompt: string;
};

export type CompiledPrompt<Flavor extends "chat" | "completion"> =
  CompiledPromptParams & {
    span_info?: PromptSpanInfo;
  } & (Flavor extends "chat"
      ? ChatPrompt
      : Flavor extends "completion"
        ? CompletionPrompt
        : {});

export type DefaultPromptArgs = Record<string, unknown>;

type PromptMetadata = {
  id?: string;
  project_id?: string;
  name: string;
  slug: string;
  prompt_data?: unknown;
  prompt_session_id?: string;
  _xact_id?: string;
};

type PromptBuildOptions = {
  messages?: Message[];
  strict?: boolean;
  templateFormat?: TemplateFormat;
};

function isAttachmentObject(value: unknown): boolean {
  return (
    BraintrustAttachmentReferenceSchema.safeParse(value).success ||
    InlineAttachmentReferenceSchema.safeParse(value).success ||
    ExternalAttachmentReferenceSchema.safeParse(value).success
  );
}

function isReadonlyAttachmentLike(value: unknown): boolean {
  if (!isObject(value)) {
    return false;
  }

  return (
    "reference" in value &&
    "data" in value &&
    typeof value.data === "function" &&
    "metadata" in value &&
    typeof value.metadata === "function"
  );
}

function isURL(url: string): boolean {
  try {
    const parsedUrl = new URL(url.trim());
    return parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:";
  } catch {
    return false;
  }
}

function expandAttachmentArrayPreTemplate(
  content: unknown,
  variables: Record<string, unknown>,
): unknown[] | null {
  if (typeof content !== "string") {
    return null;
  }

  const match = content.match(/^\{\{\s*([\w.]+)\s*\}\}$/);
  if (!match) {
    return null;
  }

  const varPath = match[1];
  const value = varPath.includes(".")
    ? getObjValueByPath(variables, varPath.split("."))
    : variables[varPath];

  if (!Array.isArray(value)) {
    return null;
  }

  const allValid = value.every(
    (v) => isAttachmentObject(v) || (typeof v === "string" && isURL(v)),
  );
  if (!allValid) {
    return null;
  }

  return value.map((item) => ({
    type: "image_url" as const,
    image_url: { url: item },
  }));
}

export function renderMessage<T extends Message>(
  render: (template: string) => string,
  message: T,
): T;

export function renderMessage<T extends Message>(
  render: (template: string) => string,
  message: T,
): T {
  return renderMessageImpl(render, message, {});
}

export function renderMessageImpl<T extends Message>(
  render: (template: string) => string,
  message: T,
  variables?: Record<string, unknown>,
): T {
  return {
    ...message,
    ...("content" in message
      ? {
          content: isEmpty(message.content)
            ? undefined
            : typeof message.content === "string"
              ? render(message.content)
              : message.content.flatMap((c) => {
                  switch (c.type) {
                    case "text":
                      return [{ ...c, text: render(c.text) }];
                    case "image_url":
                      if (isObject(c.image_url.url)) {
                        throw new Error(
                          "Attachments must be replaced with URLs before calling `build()`",
                        );
                      }

                      if (variables) {
                        const expanded = expandAttachmentArrayPreTemplate(
                          c.image_url.url,
                          variables,
                        );
                        if (expanded) {
                          return expanded;
                        }
                      }

                      return [
                        {
                          ...c,
                          image_url: {
                            ...c.image_url,
                            url: render(c.image_url.url),
                          },
                        },
                      ];
                    case "file":
                      return [
                        {
                          ...c,
                          file: {
                            ...(c.file.file_data && {
                              file_data: render(c.file.file_data),
                            }),
                            ...(c.file.file_id && {
                              file_id: render(c.file.file_id),
                            }),
                            ...(c.file.filename && {
                              filename: render(c.file.filename),
                            }),
                          },
                        },
                      ];
                    default:
                      return c;
                  }
                }),
        }
      : {}),
    ...("tool_calls" in message
      ? {
          tool_calls: isEmpty(message.tool_calls)
            ? undefined
            : message.tool_calls.map((t) => ({
                type: t.type,
                id: render(t.id),
                function: {
                  name: render(t.function.name),
                  arguments: render(t.function.arguments),
                },
              })),
        }
      : {}),
    ...("tool_call_id" in message
      ? {
          tool_call_id: render(message.tool_call_id),
        }
      : {}),
  };
}

export function deserializePlainStringAsJSON(s: string) {
  if (s.trim() === "") {
    return { value: null, error: undefined };
  }

  try {
    return { value: JSON.parse(s), error: undefined };
  } catch (error) {
    return { value: s, error };
  }
}

function renderTemplatedObject(
  obj: unknown,
  args: Record<string, unknown>,
  options: { strict?: boolean; templateFormat: TemplateFormat },
): unknown {
  if (typeof obj === "string") {
    return renderTemplateContent(
      obj,
      args,
      (value) => (typeof value === "string" ? value : JSON.stringify(value)),
      options,
    );
  }

  if (isArray(obj)) {
    return obj.map((item) => renderTemplatedObject(item, args, options));
  }

  if (isObject(obj)) {
    return Object.fromEntries(
      Object.entries(obj).map(([key, value]) => [
        key,
        renderTemplatedObject(value, args, options),
      ]),
    );
  }

  return obj;
}

export function renderPromptParams(
  params: Record<string, unknown> | undefined,
  args: Record<string, unknown>,
  options: { strict?: boolean; templateFormat?: TemplateFormat } = {},
): Record<string, unknown> | undefined {
  const templateFormat = parseTemplateFormat(options.templateFormat);
  const strict = !!options.strict;

  const schemaParsed = z
    .object({
      response_format: z.object({
        type: z.literal("json_schema"),
        json_schema: responseFormatJsonSchemaSchema
          .omit({ schema: true })
          .extend({
            schema: z.unknown(),
          }),
      }),
    })
    .safeParse(params);

  if (!schemaParsed.success) {
    return params;
  }

  const rawSchema = schemaParsed.data.response_format.json_schema.schema;
  const templatedSchema = renderTemplatedObject(rawSchema, args, {
    strict,
    templateFormat,
  });
  const parsedSchema =
    typeof templatedSchema === "string"
      ? deserializePlainStringAsJSON(templatedSchema).value
      : templatedSchema;

  return {
    ...params,
    response_format: {
      ...schemaParsed.data.response_format,
      json_schema: {
        ...schemaParsed.data.response_format.json_schema,
        schema: parsedSchema,
      },
    },
  };
}

function buildPromptSpanInfo(
  metadata: PromptMetadata,
  buildArgs: unknown,
): PromptSpanInfo | undefined {
  if (
    typeof metadata.id !== "string" ||
    typeof metadata.project_id !== "string" ||
    typeof metadata[TRANSACTION_ID_FIELD] !== "string"
  ) {
    return undefined;
  }

  return {
    metadata: {
      prompt: {
        variables: isObject(buildArgs) ? buildArgs : { input: buildArgs },
        id: metadata.id,
        project_id: metadata.project_id,
        version: metadata[TRANSACTION_ID_FIELD],
        ...(typeof metadata.prompt_session_id === "string"
          ? { prompt_session_id: metadata.prompt_session_id }
          : {}),
      },
    },
  };
}

function buildPromptVariables(buildArgs: unknown): Record<string, unknown> {
  const dictArgParsed = z.record(z.unknown()).safeParse(buildArgs);
  return {
    input: buildArgs,
    ...(dictArgParsed.success ? dictArgParsed.data : {}),
  };
}

function compilePromptParams(
  params: Record<string, unknown>,
  variables: Record<string, unknown>,
  options: { strict?: boolean; templateFormat?: TemplateFormat },
): CompiledPromptParams {
  const rendered = renderPromptParams(params, variables, options) ?? params;
  const model = rendered.model;
  if (typeof model !== "string" || isEmpty(model)) {
    throw new Error(
      "No model specified. Either specify it in the prompt or as a default",
    );
  }

  return {
    ...rendered,
    model,
  };
}

export class Prompt {
  private parsedPromptData: PromptData | undefined;
  private hasParsedPromptData = false;
  private readonly __braintrust_prompt_marker = true;

  constructor(
    private metadata: PromptMetadata,
    private defaults: DefaultPromptArgs = {},
    private noTrace = false,
  ) {}

  public get id(): string | undefined {
    return this.metadata.id;
  }

  public get projectId(): string | undefined {
    return this.metadata.project_id;
  }

  public get name(): string {
    return this.metadata.name;
  }

  public get slug(): string {
    return this.metadata.slug;
  }

  public get prompt(): PromptData["prompt"] | undefined {
    return this.getParsedPromptData().prompt;
  }

  public get version(): TransactionId | undefined {
    return this.metadata[TRANSACTION_ID_FIELD];
  }

  public get options(): NonNullable<PromptData["options"]> {
    return this.getParsedPromptData().options || {};
  }

  public get templateFormat(): string | null | undefined {
    return this.getParsedPromptData().template_format;
  }

  public get promptData(): PromptData {
    return this.getParsedPromptData();
  }

  public build(
    buildArgs: unknown,
    options: PromptBuildOptions & { flavor?: "chat" },
  ): CompiledPrompt<"chat">;
  public build(
    buildArgs: unknown,
    options: PromptBuildOptions & { flavor: "completion" },
  ): CompiledPrompt<"completion">;
  public build(
    buildArgs: unknown,
    options: PromptBuildOptions & { flavor?: "chat" | "completion" } = {},
  ): CompiledPrompt<"chat"> | CompiledPrompt<"completion"> {
    const flavor = options.flavor ?? "chat";
    return this.runBuild(buildArgs, {
      flavor,
      messages: options.messages,
      strict: options.strict,
      templateFormat: options.templateFormat,
    });
  }

  private runBuild(
    buildArgs: unknown,
    options: PromptBuildOptions & { flavor: "chat" | "completion" },
  ): CompiledPrompt<"chat"> | CompiledPrompt<"completion"> {
    const params = Object.fromEntries(
      Object.entries({
        ...this.defaults,
        ...Object.fromEntries(
          Object.entries(this.options.params || {}).filter(
            ([key]) => !BRAINTRUST_PARAMS.includes(key),
          ),
        ),
        ...(!isEmpty(this.options.model)
          ? {
              model: this.options.model,
            }
          : {}),
      }).filter(([key, value]) => key !== "response_format" || value !== null),
    );

    if (!("model" in params) || isEmpty(params.model)) {
      throw new Error(
        "No model specified. Either specify it in the prompt or as a default",
      );
    }

    const prompt = this.prompt;
    if (!prompt) {
      throw new Error("Empty prompt");
    }

    const variables = buildPromptVariables(buildArgs);
    const resolvedTemplateFormat = parseTemplateFormat(
      options.templateFormat ?? this.templateFormat,
    );
    const renderedPrompt = Prompt.renderPrompt({
      prompt,
      buildArgs,
      options: { ...options, templateFormat: resolvedTemplateFormat },
    });
    const spanInfo = this.noTrace
      ? undefined
      : buildPromptSpanInfo(this.metadata, buildArgs);

    if (options.flavor === "chat") {
      if (renderedPrompt.type !== "chat") {
        throw new Error(
          "Prompt is a completion prompt. Use buildCompletion() instead",
        );
      }

      return {
        ...compilePromptParams(params, variables, {
          strict: options.strict,
          templateFormat: resolvedTemplateFormat,
        }),
        ...(spanInfo ? { span_info: spanInfo } : {}),
        messages: renderedPrompt.messages,
        ...(renderedPrompt.tools
          ? {
              tools: chatCompletionToolSchema
                .array()
                .parse(JSON.parse(renderedPrompt.tools)),
            }
          : {}),
      };
    }

    if (renderedPrompt.type !== "completion") {
      throw new Error("Prompt is a chat prompt. Use flavor: 'chat' instead");
    }

    return {
      ...compilePromptParams(params, variables, {
        strict: options.strict,
        templateFormat: resolvedTemplateFormat,
      }),
      ...(spanInfo ? { span_info: spanInfo } : {}),
      prompt: renderedPrompt.content,
    };
  }

  public static renderPrompt({
    prompt,
    buildArgs,
    options,
  }: {
    prompt: PromptBlockData;
    buildArgs: unknown;
    options: PromptBuildOptions;
  }): PromptBlockData {
    const escape = (value: unknown) => {
      if (value === undefined) {
        throw new Error("Missing!");
      }

      if (typeof value === "string") {
        return value;
      }

      if (isReadonlyAttachmentLike(value)) {
        throw new Error(
          "Use buildWithAttachments() to build prompts with attachments",
        );
      }

      return JSON.stringify(value);
    };

    const variables = buildPromptVariables(buildArgs);
    const templateFormat = parseTemplateFormat(options.templateFormat);

    if (prompt.type === "chat") {
      const render = (template: string) =>
        renderTemplateContent(template, variables, escape, {
          strict: options.strict,
          templateFormat,
        });
      const baseMessages = (prompt.messages || []).map((message) =>
        renderMessageImpl(render, message, variables),
      );
      const hasSystemPrompt = baseMessages.some(
        (message) => message.role === "system",
      );
      return {
        type: "chat",
        messages: [
          ...baseMessages,
          ...(options.messages ?? []).filter(
            (message) => !(hasSystemPrompt && message.role === "system"),
          ),
        ],
        ...(prompt.tools?.trim()
          ? {
              tools: render(prompt.tools),
            }
          : {}),
      };
    }

    if (options.messages) {
      throw new Error(
        "extra messages are not supported for completion prompts",
      );
    }

    return {
      type: "completion",
      content: renderTemplateContent(prompt.content, variables, escape, {
        strict: options.strict,
        templateFormat,
      }),
    };
  }

  public static fromPromptData(name: string, promptData: PromptData): Prompt {
    return new Prompt(
      {
        name,
        slug: name,
        prompt_data: promptData,
      },
      {},
    );
  }

  private getParsedPromptData(): PromptData {
    if (!this.hasParsedPromptData) {
      this.parsedPromptData = promptDataSchema.parse(this.metadata.prompt_data);
      this.hasParsedPromptData = true;
    }

    if (!this.parsedPromptData) {
      throw new Error("Invalid prompt data");
    }

    return this.parsedPromptData;
  }

  public static isPrompt(data: unknown): data is Prompt {
    return (
      typeof data === "object" &&
      data !== null &&
      "__braintrust_prompt_marker" in data
    );
  }
}

export {
  getTemplateRenderer,
  isTemplateFormat,
  parseTemplateFormat,
  registerTemplatePlugin,
  renderTemplateContent,
  templateRegistry,
};

export type {
  Message,
  PromptBlockData,
  PromptData,
  TemplateFormat,
  TemplateRenderer,
  TemplateRendererPlugin,
};
