/**
 * Minimal vendored types for @mastra/core auto-instrumentation.
 *
 * These types describe only the runtime shapes consumed by instrumentation and
 * should never be exposed to users of the SDK.
 */

export interface MastraAgentLike {
  id?: string;
  name?: string;
}

export interface MastraAgentExecuteOptions {
  methodType?: string;
  messages?: unknown;
  input?: unknown;
  runId?: string;
  resourceId?: string;
  threadId?: string;
  [key: string]: unknown;
}

export interface MastraAgentNetworkOptions {
  runId?: string;
  resourceId?: string;
  threadId?: string;
  memory?: {
    thread?: string | { id?: string };
    resource?: string;
  };
  [key: string]: unknown;
}

export interface MastraToolLike {
  id?: string;
  name?: string;
  toolName?: string;
}

export interface MastraToolContext {
  agent?: {
    agentId?: string;
    toolCallId?: string;
    threadId?: string;
    resourceId?: string;
  };
  workflow?: {
    workflowId?: string;
    runId?: string;
  };
  [key: string]: unknown;
}

export interface MastraWorkflowRunLike {
  workflowId?: string;
  runId?: string;
  resourceId?: string;
  [key: string]: unknown;
}

export interface MastraWorkflowStartArgs {
  inputData?: unknown;
  initialState?: unknown;
  [key: string]: unknown;
}

export interface MastraWorkflowResumeArgs {
  resumeData?: unknown;
  step?: unknown;
  label?: string;
  [key: string]: unknown;
}

export interface MastraWorkflowRestartArgs {
  inputData?: unknown;
  step?: unknown;
  [key: string]: unknown;
}

export interface MastraWorkflowStepParams {
  workflowId?: string;
  runId?: string;
  resourceId?: string;
  [key: string]: unknown;
}
