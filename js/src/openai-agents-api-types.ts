export interface StartOpenAIAgentsTraceArgs {
  input?: unknown;
  agent?: {
    id?: string;
    model?: string;
    name?: string | null;
    [key: string]: unknown;
  } | null;
  agent_id?: string;
  metadata?: Record<string, unknown> | null;
}

export interface OpenAIAgentsTraceStartChannelArgs {
  args: StartOpenAIAgentsTraceArgs;
  state: OpenAIAgentsTraceState;
}

export type OpenAIAgentsOpenTool = {
  itemId: string;
  name: string;
  startTime: number;
  toolType: string;
  turnId?: string;
};

export type OpenAIAgentsSubagent = {
  closedAt?: number;
  openedAt: number;
  parentAgentId?: string;
};

export type OpenAIAgentsTraceState = {
  callItems: Record<string, string>;
  ended: boolean;
  eventIds: string[];
  firstTokenAt?: number;
  openTools: Record<string, OpenAIAgentsOpenTool>;
  root: string;
  rootKey: string;
  rootParent: string;
  startTime: number;
  subagents: Record<string, OpenAIAgentsSubagent>;
  turnSubagents: Record<string, string>;
  version: 1;
};

export type OpenAIAgentsTraceToken = {
  state: OpenAIAgentsTraceState | null;
  version: 1;
};
