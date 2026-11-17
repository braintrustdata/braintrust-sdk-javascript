// Narrow structural types for @fal-ai/client >=1.10.0 <2.
export type FalArgs = [
  endpointId: string,
  options?: {
    input?: unknown;
    method?: string;
    accept?: string;
    subdomain?: string;
    path?: string;
    url?: string;
  },
];

export interface FalResult {
  data: unknown;
  requestId: string;
}

export interface FalStream extends AsyncIterable<unknown> {
  on(type: "data", listener: (value: unknown) => void): void;
  done(): Promise<unknown>;
  readonly signal: AbortSignal;
  readonly requestId: string | null;
}

export interface FalClient {
  run(...args: FalArgs): Promise<FalResult>;
  stream(...args: FalArgs): Promise<FalStream>;
  streaming: { stream(...args: FalArgs): Promise<FalStream> };
}
