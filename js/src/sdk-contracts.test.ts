import { posix, win32 } from "node:path";
import ts from "typescript";
import { expect, expectTypeOf, test } from "vitest";
import { zodToJsonSchema } from "zod-to-json-schema";
import type * as Backend from "./generated_plain_types";
import * as backendSchemas from "./generated_types";
import type * as SDK from "./sdk-types";
import * as schemas from "./sdk-schemas";

test.each([
  ["POSIX", posix],
  ["Windows", win32],
] as const)(
  "model parameters preserve provider field autocomplete (%s paths)",
  (_name, path) => {
    const suggestions = [];
    for (const [module, name] of [
      ["./sdk-types", "ModelParams"],
      ["./generated_plain_types", "ModelParamsType"],
    ]) {
      // TypeScript normalizes script names before requesting their snapshots.
      const file = path
        .join(__dirname, "__model_params_completion.ts")
        .replaceAll("\\", "/");
      const source = `import type { ${name} as Params } from "${module}";\nconst params: Params = {\n\n};`;
      const service = ts.createLanguageService({
        getScriptFileNames: () => [file],
        getScriptVersion: () => "0",
        getScriptSnapshot: (path) => {
          const text = path === file ? source : ts.sys.readFile(path);
          return text === undefined
            ? undefined
            : ts.ScriptSnapshot.fromString(text);
        },
        getCurrentDirectory: () => __dirname,
        getCompilationSettings: () => ({
          strict: true,
          target: ts.ScriptTarget.ES2022,
        }),
        getDefaultLibFileName: ts.getDefaultLibFilePath,
        fileExists: ts.sys.fileExists,
        readFile: ts.sys.readFile,
        readDirectory: ts.sys.readDirectory,
      });
      try {
        suggestions.push(
          service
            .getCompletionsAtPosition(file, source.lastIndexOf("\n};"), {})
            ?.entries.filter(
              (entry) =>
                entry.kind === ts.ScriptElementKind.memberVariableElement,
            )
            .map((entry) => entry.name)
            .sort(),
        );
      } finally {
        service.dispose();
      }
    }
    expect(suggestions[0]).toEqual(suggestions[1]);
    expect(suggestions[0]).toEqual(
      expect.arrayContaining([
        "temperature",
        "top_p",
        "topP",
        "topK",
        "max_tokens",
        "maxOutputTokens",
        "response_format",
      ]),
    );
  },
);

// Backend definitions are compatibility fixtures, never production dependencies.
test("SDK-owned contracts remain compatible with the backend", () => {
  expectTypeOf<SDK.IfExists>().toEqualTypeOf<Backend.IfExistsType>();
  expectTypeOf<SDK.GitMetadataSettings>().toEqualTypeOf<Backend.GitMetadataSettingsType>();
  expectTypeOf<SDK.ObjectReference>().toEqualTypeOf<Backend.ObjectReferenceType>();
  expectTypeOf<SDK.RepoInfo>().toEqualTypeOf<Backend.RepoInfoType>();
  expectTypeOf<SDK.SSEProgressEventData>().toEqualTypeOf<Backend.SSEProgressEventDataType>();
  expectTypeOf<SDK.FunctionObjectType>().toEqualTypeOf<Backend.FunctionObjectTypeType>();
  expectTypeOf<
    Exclude<SDK.SSEProgressEventData["origin"], undefined>
  >().toEqualTypeOf<Backend.ObjectReferenceNullishType>();
  expectTypeOf<SDK.FunctionFormat>().toEqualTypeOf<Backend.FunctionFormatType>();
  expectTypeOf<SDK.FunctionOutputType>().toEqualTypeOf<Backend.FunctionOutputTypeType>();
  expectTypeOf<SDK.FunctionTypeEnum>().toEqualTypeOf<Backend.FunctionTypeEnumType>();
  expectTypeOf<SDK.SavedFunctionId>().toEqualTypeOf<Backend.SavedFunctionIdType>();
  expectTypeOf<SDK.PromptBlockData>().toEqualTypeOf<Backend.PromptBlockDataType>();
  expectTypeOf<SDK.ChatCompletionMessageParam>().toEqualTypeOf<Backend.ChatCompletionMessageParamType>();
  expectTypeOf<SDK.ChatCompletionContentPartText>().toEqualTypeOf<Backend.ChatCompletionContentPartTextType>();
  expectTypeOf<SDK.ChatCompletionContentPart>().toEqualTypeOf<Backend.ChatCompletionContentPartType>();
  expectTypeOf<SDK.ChatCompletionContentPartText>().toEqualTypeOf<Backend.ChatCompletionContentPartTextWithTitleType>();
  expectTypeOf<SDK.ChatCompletionContentPartImageWithTitle>().toEqualTypeOf<Backend.ChatCompletionContentPartImageWithTitleType>();
  expectTypeOf<SDK.ChatCompletionContentPartFileWithTitle>().toEqualTypeOf<Backend.ChatCompletionContentPartFileWithTitleType>();
  expectTypeOf<SDK.ChatCompletionContentPartFileFile>().toEqualTypeOf<Backend.ChatCompletionContentPartFileFileType>();
  expectTypeOf<SDK.ChatCompletionMessageToolCall>().toEqualTypeOf<Backend.ChatCompletionMessageToolCallType>();
  expectTypeOf<SDK.ChatCompletionMessageReasoning>().toEqualTypeOf<Backend.ChatCompletionMessageReasoningType>();
  expectTypeOf<SDK.PromptData>().branded.toEqualTypeOf<Backend.PromptDataType>();
  expectTypeOf<
    Exclude<SDK.PromptData["prompt"], undefined>
  >().toEqualTypeOf<Backend.PromptBlockDataNullishType>();
  expectTypeOf<SDK.PromptOptionsNullish>().branded.toEqualTypeOf<Backend.PromptOptionsNullishType>();
  // Structural equality accommodates explicit fields replacing mapped intersections.
  expectTypeOf<SDK.ModelParams>().branded.toEqualTypeOf<Backend.ModelParamsType>();
  expectTypeOf<SDK.ModelParams>().toExtend<Backend.ModelParamsType>();
  expectTypeOf<Backend.ModelParamsType>().toExtend<SDK.ModelParams>();
  expectTypeOf<SDK.ResponseFormatNullish>().toEqualTypeOf<Backend.ResponseFormatNullishType>();
  expectTypeOf<SDK.ResponseFormatJsonSchema>().toEqualTypeOf<Backend.ResponseFormatJsonSchemaType>();
  expectTypeOf<SDK.PromptParserNullish>().toEqualTypeOf<Backend.PromptParserNullishType>();
  expectTypeOf<SDK.PreprocessorId>().toEqualTypeOf<Backend.PreprocessorIdType>();
  expectTypeOf<SDK.ToolFunctionDefinition>().toEqualTypeOf<Backend.ToolFunctionDefinitionType>();
  expectTypeOf<SDK.ExtendedSavedFunctionId>().toEqualTypeOf<Backend.ExtendedSavedFunctionIdType>();
  expectTypeOf<SDK.AttachmentReference>().toEqualTypeOf<Backend.AttachmentReferenceType>();
  expectTypeOf<SDK.BraintrustAttachmentReference>().toEqualTypeOf<Backend.BraintrustAttachmentReferenceType>();
  expectTypeOf<SDK.ExternalAttachmentReference>().toEqualTypeOf<Backend.ExternalAttachmentReferenceType>();
  expectTypeOf<SDK.ChatCompletionTool>().toEqualTypeOf<Backend.ChatCompletionToolType>();
  expectTypeOf<SDK.AttachmentStatus>().toEqualTypeOf<Backend.AttachmentStatusType>();
  expectTypeOf<SDK.UploadStatus>().toEqualTypeOf<Backend.UploadStatusType>();
  expectTypeOf<SDK.ChatCompletionOpenAIMessageParam>().toEqualTypeOf<Backend.ChatCompletionOpenAIMessageParamType>();
  expectTypeOf<SDK.DatasetSnapshot>().toEqualTypeOf<Backend.DatasetSnapshotType>();
  expectTypeOf<SDK.PromptData | null>().branded.toEqualTypeOf<Backend.PromptDataNullishType>();
  expectTypeOf<SDK.FunctionTypeEnum | null>().toEqualTypeOf<Backend.FunctionTypeEnumNullishType>();
  expectTypeOf<SDK.PromptSessionEvent>().toEqualTypeOf<Backend.PromptSessionEventType>();
  expectTypeOf<SDK.InvokeFunction>().branded.toEqualTypeOf<Backend.InvokeFunctionType>();
  expectTypeOf<SDK.FunctionId>().branded.toEqualTypeOf<Backend.FunctionIdType>();
  expectTypeOf<SDK.InvokeParent>().toEqualTypeOf<Backend.InvokeParentType>();
  expectTypeOf<SDK.StreamingMode>().toEqualTypeOf<Backend.StreamingModeType>();
  expectTypeOf<SDK.CallEvent>().toEqualTypeOf<Backend.CallEventType>();
  expectTypeOf<SDK.SSEConsoleEventData>().toEqualTypeOf<Backend.SSEConsoleEventDataType>();
  expectTypeOf<SDK.AsyncScoringControl>().toEqualTypeOf<Backend.AsyncScoringControlType>();
  expectTypeOf<SDK.AsyncScoringState>().toEqualTypeOf<Backend.AsyncScoringStateType>();
});

test.each([
  "PromptData",
  "ObjectReference",
  "Project",
  "AttachmentReference",
  "BraintrustAttachmentReference",
  "BraintrustModelParams",
  "ChatCompletionTool",
  "ExternalAttachmentReference",
  "ResponseFormatJsonSchema",
  "AttachmentStatus",
  "GitMetadataSettings",
  "DatasetSnapshot",
  "Prompt",
  "FunctionId",
  "CallEvent",
  "SSEConsoleEventData",
  "SSEProgressEventData",
] as const)("%s preserves backend validation constraints", (name) => {
  expect(zodToJsonSchema(schemas[name])).toEqual(
    zodToJsonSchema(backendSchemas[name]),
  );
});

const id = "12345678-1234-4234-8234-123456789012";
const fixtures: Partial<Record<keyof typeof schemas, unknown[]>> = {
  AttachmentReference: [
    {
      type: "braintrust_attachment",
      filename: "file",
      content_type: "text/plain",
      key: "key",
    },
    {
      type: "external_attachment",
      filename: "file",
      content_type: "text/plain",
      url: "https://example.com/file",
    },
    {
      type: "braintrust_attachment",
      filename: "",
      content_type: "text/plain",
      key: "key",
    },
  ],
  AttachmentStatus: [{ upload_status: "done" }, { upload_status: "invalid" }],
  FunctionId: [
    { function_id: id },
    { project_name: "project", slug: "prompt" },
    { global_function: "scorer" },
    { prompt_session_id: id, prompt_session_function_id: id },
    {
      inline_prompt: { prompt: { type: "completion", content: "Hello" } },
      function_type: "llm",
    },
  ],
  PromptData: [
    {
      prompt: { type: "chat", messages: [{ role: "user" }, { role: "tool" }] },
      options: { model: "model", params: { temperature: 0, custom: true } },
      extra: "strip",
    },
    {
      prompt: { type: "completion", content: "Hello" },
      options: null,
      parser: null,
    },
    { prompt: { type: "chat", messages: [{ role: "invalid" }] } },
  ],
  Prompt: [
    {
      id,
      project_id: id,
      org_id: id,
      _xact_id: "version",
      log_id: "p",
      name: "prompt",
      slug: "prompt",
      extra: "strip",
    },
  ],
  DatasetSnapshot: [
    {
      id,
      dataset_id: id,
      name: "snapshot",
      description: null,
      xact_id: "version",
      created: null,
    },
  ],
  ObjectReference: [
    { object_type: "dataset", object_id: id, id },
    { object_type: "invalid", object_id: id, id },
  ],
  Project: [
    {
      id,
      org_id: id,
      name: "project",
      settings: { blind_reviews: true },
      extra: "strip",
    },
  ],
  CallEvent: [
    { event: "start" },
    { event: "done" },
    { event: "text_delta", data: "hello" },
    { event: "invalid", data: "hello" },
  ],
  GitMetadataSettings: [
    { collect: "all" },
    { collect: "some", fields: ["commit"] },
    { collect: "some", fields: ["invalid"] },
  ],
};

test.each(Object.keys(schemas) as (keyof typeof schemas)[])(
  "%s preserves parsing, defaults, and errors",
  (name) => {
    for (const input of [
      undefined,
      null,
      {},
      "invalid",
      ...(fixtures[name] ?? []),
    ]) {
      const actual = schemas[name].safeParse(input);
      const expected = backendSchemas[name].safeParse(input);
      expect(actual.success, JSON.stringify(input)).toBe(expected.success);
      if (actual.success && expected.success) {
        expect(actual.data).toEqual(expected.data);
      } else if (!actual.success && !expected.success) {
        // Nested union errors have instance-specific methods; compare their
        // serialized diagnostic payload, including codes, paths, and messages.
        expect(JSON.parse(JSON.stringify(actual.error.issues))).toEqual(
          JSON.parse(JSON.stringify(expected.error.issues)),
        );
      }
    }
  },
);
