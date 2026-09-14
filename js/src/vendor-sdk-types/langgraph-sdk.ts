/** Minimal public surfaces of @langchain/langgraph-sdk >=1.9.25 <2. */
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

export interface LangGraphStreamEvent {
  event: string;
  data: unknown;
}

export interface LangGraphSDKClient {
  runs: {
    wait(...args: LangGraphRunArgs): PromiseLike<unknown>;
    stream(...args: LangGraphRunArgs): AsyncGenerator<LangGraphStreamEvent>;
  };
}
