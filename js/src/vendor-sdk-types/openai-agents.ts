/*
 * Minimal OpenAI Agents SDK tracing types used by Braintrust auto-instrumentation.
 *
 * Original source: https://github.com/openai/openai-agents-js
 * License: MIT
 */

export type OpenAIAgentsSpanDataBase = {
  type: string;
};

export type OpenAIAgentsAgentSpanData = OpenAIAgentsSpanDataBase & {
  type: "agent";
  name: string;
  handoffs?: string[];
  tools?: string[];
  output_type?: string;
};

export type OpenAIAgentsFunctionSpanData = OpenAIAgentsSpanDataBase & {
  type: "function";
  name: string;
  input: string;
  output: string;
  mcp_data?: string;
};

export type OpenAIAgentsGenerationSpanData = OpenAIAgentsSpanDataBase & {
  type: "generation";
  input?: Array<Record<string, unknown>>;
  output?: Array<Record<string, unknown>>;
  model?: string;
  model_config?: Record<string, unknown>;
  usage?: Record<string, unknown>;
};

export type OpenAIAgentsResponseSpanData = OpenAIAgentsSpanDataBase & {
  type: "response";
  response_id?: string;
  _input?: string | Record<string, unknown>[];
  _response?: Record<string, unknown>;
};

export type OpenAIAgentsHandoffSpanData = OpenAIAgentsSpanDataBase & {
  type: "handoff";
  from_agent?: string;
  to_agent?: string;
};

export type OpenAIAgentsCustomSpanData = OpenAIAgentsSpanDataBase & {
  type: "custom";
  name: string;
  data: Record<string, unknown>;
};

export type OpenAIAgentsGuardrailSpanData = OpenAIAgentsSpanDataBase & {
  type: "guardrail";
  name: string;
  triggered: boolean;
};

export type OpenAIAgentsTranscriptionSpanData = OpenAIAgentsSpanDataBase & {
  type: "transcription";
  input: {
    data: string;
    format: "pcm" | string;
  };
  output?: string;
  model?: string;
  model_config?: Record<string, unknown>;
};

export type OpenAIAgentsSpeechSpanData = OpenAIAgentsSpanDataBase & {
  type: "speech";
  input?: string;
  output: {
    data: string;
    format: "pcm" | string;
  };
  model?: string;
  model_config?: Record<string, unknown>;
};

export type OpenAIAgentsSpeechGroupSpanData = OpenAIAgentsSpanDataBase & {
  type: "speech_group";
  input?: string;
};

export type OpenAIAgentsMCPListToolsSpanData = OpenAIAgentsSpanDataBase & {
  type: "mcp_tools";
  server?: string;
  result?: string[];
};

export type OpenAIAgentsSpanData =
  | OpenAIAgentsAgentSpanData
  | OpenAIAgentsFunctionSpanData
  | OpenAIAgentsGenerationSpanData
  | OpenAIAgentsResponseSpanData
  | OpenAIAgentsHandoffSpanData
  | OpenAIAgentsCustomSpanData
  | OpenAIAgentsGuardrailSpanData
  | OpenAIAgentsTranscriptionSpanData
  | OpenAIAgentsSpeechSpanData
  | OpenAIAgentsSpeechGroupSpanData
  | OpenAIAgentsMCPListToolsSpanData;

export type OpenAIAgentsTrace = {
  type: "trace";
  traceId: string;
  name: string;
  groupId: string | null;
  metadata?: Record<string, unknown>;
};

export type OpenAIAgentsSpan<
  TData extends OpenAIAgentsSpanData = OpenAIAgentsSpanData,
> = {
  type: "trace.span";
  traceId: string;
  spanData: TData;
  spanId: string;
  parentId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  error: { message: string; data?: Record<string, unknown> } | null;
};
