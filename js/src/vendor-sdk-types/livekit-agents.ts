// Minimal structural interfaces for @livekit/agents >=1.5 <2.
export interface LiveKitAudioFrame {
  data: Int16Array;
  sampleRate: number;
  channels: number;
  samplesPerChannel: number;
}

export interface LiveKitTool {
  name?: string;
  description?: string;
  parameters?: unknown;
  execute?: (args: unknown, options?: LiveKitToolOptions) => unknown;
}

export interface LiveKitToolOptions {
  toolCallId?: string;
  ctx?: { functionCall?: { name?: string } };
  abortSignal?: AbortSignal;
}

export interface LiveKitToolContext {
  functionTools: Record<string, LiveKitTool>;
}

export interface LiveKitChatContext {
  items: Array<{
    type: string;
    role?: string;
    content?: unknown[];
    callId?: string;
    name?: string;
    args?: string;
    output?: string;
    isError?: boolean;
  }>;
}

export interface LiveKitModel {
  model?: string;
  provider?: string;
}

export type LiveKitNodeName = "sttNode" | "llmNode" | "ttsNode";

export type LiveKitNodeArgs = [
  input: unknown,
  contextOrSettings?: LiveKitToolContext | Record<string, unknown>,
  settings?: Record<string, unknown>,
];
export type LiveKitNodeResult = ReadableStream<unknown> | null;
export type LiveKitNode = (
  ...args: LiveKitNodeArgs
) => PromiseLike<LiveKitNodeResult>;

export interface LiveKitAgent {
  sttNode: LiveKitNode;
  llmNode: LiveKitNode;
  ttsNode: LiveKitNode;
  getActivityOrThrow(): {
    stt?: LiveKitModel;
    llm?: LiveKitModel;
    tts?: LiveKitModel;
  };
}

export interface LiveKitAgentsModule {
  voice: {
    Agent: {
      prototype: LiveKitAgent;
      default: Record<
        LiveKitNodeName,
        (
          agent: LiveKitAgent,
          ...args: LiveKitNodeArgs
        ) => PromiseLike<LiveKitNodeResult>
      >;
    };
  };
  llm: { tool: (definition: LiveKitTool) => LiveKitTool };
}
