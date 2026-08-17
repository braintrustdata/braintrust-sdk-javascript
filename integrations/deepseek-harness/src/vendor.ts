/** Minimal DeepSeek Harness shapes consumed by the instrumentation. */

export interface HarnessContentBlock {
  readonly type: string;
  readonly text?: string;
  readonly id?: string;
  readonly name?: string;
  readonly arguments?: string;
  readonly toolCallId?: string;
  readonly content?: readonly HarnessContentBlock[];
  readonly isError?: boolean;
  readonly attachment?: unknown;
}

export interface HarnessMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: readonly HarnessContentBlock[];
  readonly source?: {
    readonly kind?: string;
    readonly provider?: string;
    readonly model?: string;
    readonly callId?: string;
  };
}

export interface HarnessUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
}

export type HarnessStreamChunk =
  | {
      readonly type: "text-delta";
      readonly index: number;
      readonly text: string;
    }
  | {
      readonly type: "reasoning-delta";
      readonly index: number;
      readonly text: string;
    }
  | {
      readonly type: "tool-call-delta";
      readonly index: number;
      readonly id: string;
      readonly name?: string;
      readonly argumentsDelta: string;
    }
  | {
      readonly type: "block-end";
      readonly index: number;
      readonly block: HarnessContentBlock;
    }
  | { readonly type: "usage"; readonly usage: HarnessUsage }
  | {
      readonly type: "finish";
      readonly reason: {
        readonly kind: string;
        readonly failure?: { readonly message?: string };
      };
    };

export interface HarnessGenerateOptions {
  readonly provider: string;
  readonly model: string;
  readonly messages: readonly HarnessMessage[];
  readonly system?: string;
  readonly tools?: readonly {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  }[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly stop?: readonly string[];
  readonly sessionId?: string;
  readonly purpose?: "compaction" | "session-title";
}

export interface HarnessSession {
  readonly id: string;
  readonly header: {
    readonly id: string;
    readonly parentSession?: string;
    readonly delegationDepth?: number;
  };
}

export interface HarnessSessionEvent {
  readonly type: string;
  readonly data: Record<string, unknown>;
}

export interface HarnessToolExecution {
  readonly callId: string;
  readonly name: string;
  readonly arguments: unknown;
  readonly agent?: { readonly session: HarnessSession };
  readonly parent?: symbol;
  readonly token: symbol;
}

export interface HarnessToolResult {
  readonly isError: boolean;
  readonly value?: unknown;
  readonly content: readonly HarnessContentBlock[];
  readonly error?: { readonly message?: string; readonly code?: string };
}
