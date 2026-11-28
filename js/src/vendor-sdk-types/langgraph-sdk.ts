/** Minimal public surfaces of @langchain/langgraph-sdk >=1.9.25 <3. */
export interface LangGraphRunOptions {
  input?: unknown;
  command?: unknown;
  streamMode?: string | string[];
  streamSubgraphs?: boolean;
  interruptBefore?: string[] | "*";
  interruptAfter?: string[] | "*";
  multitaskStrategy?: string;
  durability?: string;
}

export type LangGraphRunArgs = [
  threadId: string | null,
  assistantId: string,
  options?: LangGraphRunOptions,
];

export type LangGraphBatchArgs = [
  payloads: (LangGraphRunOptions & { assistantId: string })[],
  options?: { signal?: AbortSignal },
];

export type LangGraphJoinArgs = [
  threadId: string,
  runId: string,
  options?: { cancelOnDisconnect?: boolean; signal?: AbortSignal },
];

export type LangGraphJoinStreamArgs = [
  threadId: string | null | undefined,
  runId: string,
  options?:
    | AbortSignal
    | {
        cancelOnDisconnect?: boolean;
        signal?: AbortSignal;
      },
];

export interface LangGraphStreamEvent {
  event: string;
  data: unknown;
}

export interface LangGraphSDKClient {
  runs: {
    create?(...args: LangGraphRunArgs): PromiseLike<unknown>;
    createBatch?(...args: LangGraphBatchArgs): PromiseLike<unknown>;
    join?(...args: LangGraphJoinArgs): PromiseLike<unknown>;
    joinStream?(
      ...args: LangGraphJoinStreamArgs
    ): AsyncGenerator<LangGraphStreamEvent>;
    wait(...args: LangGraphRunArgs): PromiseLike<unknown>;
    stream(...args: LangGraphRunArgs): AsyncGenerator<LangGraphStreamEvent>;
  };
}
