/**
 * Vendored types for the @anthropic-ai/claude-agent-sdk which our wrapper consumes.
 *
 * Should never be exposed to users of the SDK!
 */

// Shared usage shape used in message and result
interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface TaskUsage {
  duration_ms?: number;
  tool_uses?: number;
  total_tokens?: number;
}

// Shared base fields for all hook inputs
interface BaseHookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode?: string;
}

// Messages

export interface ClaudeAgentSDKMessage {
  type: string;
  subtype?: string;
  message?: {
    id?: string;
    role?: string;
    content?: unknown;
    model?: string;
    usage?: Usage;
  };
  parent_tool_use_id?: string | null;
  usage?: Usage | TaskUsage;
  num_turns?: number;
  session_id?: string;
  task_id?: string;
  tool_use_id?: string;
  status?: string;
  output_file?: string;
  summary?: string;
  description?: string;
  task_type?: string;
  workflow_name?: string;
  prompt?: string;
  last_tool_name?: string;
  [key: string]: unknown;
}

// Query

export interface ClaudeAgentSDKQueryParams {
  prompt?: string | AsyncIterable<ClaudeAgentSDKMessage>;
  options?: ClaudeAgentSDKQueryOptions;
}

export interface ClaudeAgentSDKQueryOptions {
  model?: string;
  maxTurns?: number;
  cwd?: string;
  continue?: boolean;
  allowedTools?: string[];
  disallowedTools?: string[];
  additionalDirectories?: string[];
  permissionMode?: string;
  debug?: boolean;
  apiKey?: string;
  apiKeySource?: string;
  agentName?: string;
  instructions?: string;
  mcpServers?: ClaudeAgentSDKMcpServersConfig;
  hooks?: Record<string, ClaudeAgentSDKHookCallbackMatcher[]>;
  [key: string]: unknown;
}

// MCP

export type ClaudeAgentSDKMcpServersConfig = Record<
  string,
  {
    type?: "stdio" | "sse" | "http" | "sdk";
    url?: string;
    command?: string;
    args?: string[];
    [key: string]: unknown;
  }
>;

// Module

export interface ClaudeAgentSDKModule {
  query: (
    params: ClaudeAgentSDKQueryParams,
  ) => AsyncGenerator<ClaudeAgentSDKMessage, void, unknown>;
  tool: (...args: unknown[]) => unknown;
  [key: string]: unknown;
}

// Hooks

export type ClaudeAgentSDKHookCallback = (
  input:
    | (BaseHookInput & {
        hook_event_name: "PreToolUse";
        tool_name: string;
        tool_input: unknown;
      })
    | (BaseHookInput & {
        hook_event_name: "PostToolUse";
        tool_name: string;
        tool_input: unknown;
        tool_response: unknown;
      })
    | (BaseHookInput & {
        hook_event_name: "PostToolUseFailure";
        tool_name: string;
        tool_input: unknown;
        error: string;
        is_interrupt?: boolean;
      })
    | (BaseHookInput & {
        hook_event_name: "SubagentStart";
        agent_id: string;
        agent_type: string;
      })
    | (BaseHookInput & {
        hook_event_name: "SubagentStop";
        agent_id: string;
        agent_type?: string;
        agent_transcript_path?: string;
        stop_hook_active: boolean;
        last_assistant_message?: string;
      }),
  toolUseID: string | undefined,
  options: { signal: AbortSignal },
) => Promise<{
  continue?: boolean;
  decision?: "approve" | "block";
  [key: string]: unknown;
}>;

export interface ClaudeAgentSDKHookCallbackMatcher {
  matcher?: string;
  hooks: ClaudeAgentSDKHookCallback[];
}
