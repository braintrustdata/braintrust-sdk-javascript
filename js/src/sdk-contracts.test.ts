import { expectTypeOf, test } from "vitest";
import type { z } from "zod/v3";
import type * as Backend from "./generated_plain_types";
import type * as backendSchemas from "./generated_types";
import type * as SDK from "./sdk-types";
import type * as schemas from "./sdk-schemas";

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

test("runtime validators accept and return compatible types", () => {
  expectTypeOf<z.input<typeof schemas.PromptData>>().toEqualTypeOf<
    z.input<typeof backendSchemas.PromptData>
  >();
  expectTypeOf<z.output<typeof schemas.PromptData>>().toEqualTypeOf<
    z.output<typeof backendSchemas.PromptData>
  >();
  expectTypeOf<z.input<typeof schemas.ObjectReference>>().toEqualTypeOf<
    z.input<typeof backendSchemas.ObjectReference>
  >();
  expectTypeOf<z.output<typeof schemas.ObjectReference>>().toEqualTypeOf<
    z.output<typeof backendSchemas.ObjectReference>
  >();
  expectTypeOf<z.input<typeof schemas.Project>>().toEqualTypeOf<
    z.input<typeof backendSchemas.Project>
  >();
  expectTypeOf<z.output<typeof schemas.Project>>().toEqualTypeOf<
    z.output<typeof backendSchemas.Project>
  >();
  expectTypeOf<z.input<typeof schemas.AttachmentReference>>().toEqualTypeOf<
    z.input<typeof backendSchemas.AttachmentReference>
  >();
  expectTypeOf<z.output<typeof schemas.AttachmentReference>>().toEqualTypeOf<
    z.output<typeof backendSchemas.AttachmentReference>
  >();
  expectTypeOf<
    z.input<typeof schemas.BraintrustAttachmentReference>
  >().toEqualTypeOf<
    z.input<typeof backendSchemas.BraintrustAttachmentReference>
  >();
  expectTypeOf<
    z.output<typeof schemas.BraintrustAttachmentReference>
  >().toEqualTypeOf<
    z.output<typeof backendSchemas.BraintrustAttachmentReference>
  >();
  expectTypeOf<z.input<typeof schemas.BraintrustModelParams>>().toEqualTypeOf<
    z.input<typeof backendSchemas.BraintrustModelParams>
  >();
  expectTypeOf<z.output<typeof schemas.BraintrustModelParams>>().toEqualTypeOf<
    z.output<typeof backendSchemas.BraintrustModelParams>
  >();
  expectTypeOf<z.input<typeof schemas.ChatCompletionTool>>().toEqualTypeOf<
    z.input<typeof backendSchemas.ChatCompletionTool>
  >();
  expectTypeOf<z.output<typeof schemas.ChatCompletionTool>>().toEqualTypeOf<
    z.output<typeof backendSchemas.ChatCompletionTool>
  >();
  expectTypeOf<
    z.input<typeof schemas.ExternalAttachmentReference>
  >().toEqualTypeOf<
    z.input<typeof backendSchemas.ExternalAttachmentReference>
  >();
  expectTypeOf<
    z.output<typeof schemas.ExternalAttachmentReference>
  >().toEqualTypeOf<
    z.output<typeof backendSchemas.ExternalAttachmentReference>
  >();
  expectTypeOf<
    z.input<typeof schemas.ResponseFormatJsonSchema>
  >().toEqualTypeOf<z.input<typeof backendSchemas.ResponseFormatJsonSchema>>();
  expectTypeOf<
    z.output<typeof schemas.ResponseFormatJsonSchema>
  >().toEqualTypeOf<z.output<typeof backendSchemas.ResponseFormatJsonSchema>>();
  expectTypeOf<z.input<typeof schemas.AttachmentStatus>>().toEqualTypeOf<
    z.input<typeof backendSchemas.AttachmentStatus>
  >();
  expectTypeOf<z.output<typeof schemas.AttachmentStatus>>().toEqualTypeOf<
    z.output<typeof backendSchemas.AttachmentStatus>
  >();
  expectTypeOf<z.input<typeof schemas.GitMetadataSettings>>().toEqualTypeOf<
    z.input<typeof backendSchemas.GitMetadataSettings>
  >();
  expectTypeOf<z.output<typeof schemas.GitMetadataSettings>>().toEqualTypeOf<
    z.output<typeof backendSchemas.GitMetadataSettings>
  >();
  expectTypeOf<z.input<typeof schemas.DatasetSnapshot>>().toEqualTypeOf<
    z.input<typeof backendSchemas.DatasetSnapshot>
  >();
  expectTypeOf<z.output<typeof schemas.DatasetSnapshot>>().toEqualTypeOf<
    z.output<typeof backendSchemas.DatasetSnapshot>
  >();
  expectTypeOf<z.input<typeof schemas.Prompt>>().toEqualTypeOf<
    z.input<typeof backendSchemas.Prompt>
  >();
  expectTypeOf<z.output<typeof schemas.Prompt>>().toEqualTypeOf<
    z.output<typeof backendSchemas.Prompt>
  >();
  expectTypeOf<z.input<typeof schemas.FunctionId>>().toEqualTypeOf<
    z.input<typeof backendSchemas.FunctionId>
  >();
  expectTypeOf<z.output<typeof schemas.FunctionId>>().toEqualTypeOf<
    z.output<typeof backendSchemas.FunctionId>
  >();
  expectTypeOf<z.input<typeof schemas.CallEvent>>().toEqualTypeOf<
    z.input<typeof backendSchemas.CallEvent>
  >();
  expectTypeOf<z.output<typeof schemas.CallEvent>>().toEqualTypeOf<
    z.output<typeof backendSchemas.CallEvent>
  >();
  expectTypeOf<z.input<typeof schemas.SSEConsoleEventData>>().toEqualTypeOf<
    z.input<typeof backendSchemas.SSEConsoleEventData>
  >();
  expectTypeOf<z.output<typeof schemas.SSEConsoleEventData>>().toEqualTypeOf<
    z.output<typeof backendSchemas.SSEConsoleEventData>
  >();
  expectTypeOf<z.input<typeof schemas.SSEProgressEventData>>().toEqualTypeOf<
    z.input<typeof backendSchemas.SSEProgressEventData>
  >();
  expectTypeOf<z.output<typeof schemas.SSEProgressEventData>>().toEqualTypeOf<
    z.output<typeof backendSchemas.SSEProgressEventData>
  >();
});
