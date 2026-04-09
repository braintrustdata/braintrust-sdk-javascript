/**
 * Vendored types for the @google/adk SDK which our wrapper consumes.
 *
 * Should never be exposed to users of the SDK!
 */

// ---- Runner ----

export interface GoogleADKRunnerConstructor {
  new (input: GoogleADKRunnerInput): GoogleADKRunner;
}

export interface GoogleADKInMemoryRunnerConstructor {
  new (input: GoogleADKInMemoryRunnerInput): GoogleADKRunner;
}

export interface GoogleADKRunnerInput {
  appName: string;
  agent: GoogleADKBaseAgent;
  sessionService?: unknown;
  artifactService?: unknown;
  memoryService?: unknown;
  credentialService?: unknown;
  plugins?: unknown[];
}

export interface GoogleADKInMemoryRunnerInput {
  agent: GoogleADKBaseAgent;
  appName?: string;
  plugins?: unknown[];
}

export interface GoogleADKRunAsyncParams {
  userId: string;
  sessionId: string;
  newMessage?: GoogleADKContent;
  stateDelta?: Record<string, unknown>;
  runConfig?: unknown;
}

export interface GoogleADKRunner {
  appName: string;
  agent: GoogleADKBaseAgent;
  runAsync(params: GoogleADKRunAsyncParams): AsyncGenerator<GoogleADKEvent>;
  runEphemeral?(params: {
    userId: string;
    newMessage?: GoogleADKContent;
    stateDelta?: Record<string, unknown>;
    runConfig?: unknown;
  }): AsyncGenerator<GoogleADKEvent>;
}

// ---- Agents ----

export interface GoogleADKBaseAgent {
  name: string;
  description?: string;
  subAgents?: GoogleADKBaseAgent[];
  parentAgent?: GoogleADKBaseAgent;
  runAsync(parentContext: unknown): AsyncGenerator<GoogleADKEvent>;
}

export interface GoogleADKLlmAgent extends GoogleADKBaseAgent {
  model?: string | { model: string };
  instruction?: string | ((...args: unknown[]) => Promise<string>);
  tools?: unknown[];
}

// ---- Tools ----

export interface GoogleADKBaseTool {
  name: string;
  description?: string;
  runAsync(req: GoogleADKToolRunRequest): Promise<unknown>;
}

export interface GoogleADKToolRunRequest {
  args: Record<string, unknown>;
  toolContext?: unknown;
  [key: string]: unknown;
}

// ---- Events ----

export interface GoogleADKEvent {
  id?: string;
  invocationId?: string;
  author?: string;
  timestamp?: number;
  content?: GoogleADKContent;
  partial?: boolean;
  turnComplete?: boolean;
  actions?: GoogleADKEventActions;
  errorCode?: number;
  errorMessage?: string;
  usageMetadata?: GoogleADKUsageMetadata;
  longRunningToolIds?: string[];
}

export interface GoogleADKEventActions {
  stateDelta?: Record<string, unknown>;
  artifactDelta?: Record<string, number>;
  transferToAgent?: string;
  escalate?: boolean;
  skipSummarization?: boolean;
}

// ---- Content ----

export interface GoogleADKContent {
  role?: string;
  parts?: GoogleADKPart[];
}

export interface GoogleADKPart {
  text?: string;
  thought?: boolean;
  functionCall?: {
    id?: string;
    name: string;
    args: Record<string, unknown>;
  };
  functionResponse?: {
    id?: string;
    name: string;
    response: unknown;
  };
  inlineData?: {
    data: Uint8Array | string;
    mimeType: string;
  };
  executableCode?: Record<string, unknown>;
  codeExecutionResult?: Record<string, unknown>;
}

// ---- Usage ----

export interface GoogleADKUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
}

// ---- Module shape ----

export interface GoogleADKModule {
  Runner: GoogleADKRunnerConstructor;
  InMemoryRunner: GoogleADKInMemoryRunnerConstructor;
  LlmAgent: new (config: unknown) => GoogleADKLlmAgent;
  Agent: new (config: unknown) => GoogleADKLlmAgent;
  BaseAgent: new (config: unknown) => GoogleADKBaseAgent;
  SequentialAgent: new (config: unknown) => GoogleADKBaseAgent;
  ParallelAgent: new (config: unknown) => GoogleADKBaseAgent;
  LoopAgent: new (config: unknown) => GoogleADKBaseAgent;
  FunctionTool: new (config: unknown) => GoogleADKBaseTool;
  [key: string]: unknown;
}
