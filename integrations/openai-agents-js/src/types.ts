import { Logger } from "braintrust";
import type {
  SpanData,
  AgentSpanData,
  FunctionSpanData,
  GenerationSpanData,
  ResponseSpanData,
  HandoffSpanData,
  CustomSpanData,
  GuardrailSpanData,
  MCPListToolsSpanData,
  TranscriptionSpanData,
  SpeechSpanData,
  SpeechGroupSpanData,
  Trace,
  Span,
} from "./openai-agents-types";

export enum SpanType {
  AGENT = "agent",
  RESPONSE = "response",
  FUNCTION = "function",
  HANDOFF = "handoff",
  GUARDRAIL = "guardrail",
  GENERATION = "generation",
  CUSTOM = "custom",
  MCP_TOOLS = "mcp_tools",
  TRANSCRIPTION = "transcription",
  SPEECH = "speech",
  SPEECH_GROUP = "speech_group",
}

export type AgentsTrace = Trace;

export type AgentsSpan = Span<SpanData>;

export type SpanInput =
  | string
  | Array<Record<string, unknown>>
  | Record<string, unknown>[];

export type SpanOutput =
  | string
  | Array<Record<string, unknown>>
  | Record<string, unknown>;

export type TraceMetadata = {
  firstInput: SpanInput | null;
  lastOutput: SpanOutput | null;
};

export interface OpenAIAgentsTraceProcessorOptions {
  logger?: Logger;
  maxTraces?: number;
}

// Type guard functions
export function isResponseSpanData(
  spanData: SpanData,
): spanData is ResponseSpanData {
  return spanData.type === SpanType.RESPONSE;
}

export function isGenerationSpanData(
  spanData: SpanData,
): spanData is GenerationSpanData {
  return spanData.type === SpanType.GENERATION;
}

export function isAgentSpanData(spanData: SpanData): spanData is AgentSpanData {
  return spanData.type === SpanType.AGENT;
}

export function isFunctionSpanData(
  spanData: SpanData,
): spanData is FunctionSpanData {
  return spanData.type === SpanType.FUNCTION;
}

export function isHandoffSpanData(
  spanData: SpanData,
): spanData is HandoffSpanData {
  return spanData.type === SpanType.HANDOFF;
}

export function isGuardrailSpanData(
  spanData: SpanData,
): spanData is GuardrailSpanData {
  return spanData.type === SpanType.GUARDRAIL;
}

export function isCustomSpanData(
  spanData: SpanData,
): spanData is CustomSpanData {
  return spanData.type === SpanType.CUSTOM;
}

export function isMCPListToolsSpanData(
  spanData: SpanData,
): spanData is MCPListToolsSpanData {
  return spanData.type === SpanType.MCP_TOOLS;
}

export function isTranscriptionSpanData(
  spanData: SpanData,
): spanData is TranscriptionSpanData {
  return spanData.type === SpanType.TRANSCRIPTION;
}

export function isSpeechSpanData(
  spanData: SpanData,
): spanData is SpeechSpanData {
  return spanData.type === SpanType.SPEECH;
}

export function isSpeechGroupSpanData(
  spanData: SpanData,
): spanData is SpeechGroupSpanData {
  return spanData.type === SpanType.SPEECH_GROUP;
}
