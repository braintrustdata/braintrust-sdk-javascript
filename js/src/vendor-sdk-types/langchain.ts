import type { Logger, Span, StartSpanArgs } from "../logger";
import type { ExperimentLogPartialArgs } from "../util";

export type LangChainSerialized = {
  id?: unknown[];
  name?: string;
};

export type LangChainRunnableConfig = Record<string, unknown>;

export type LangChainCallbackManager = {
  handlers?: unknown[];
  addHandler?: (handler: unknown, inherit?: boolean) => void;
};

export type LangChainCallbackManagerConfigureResult =
  | LangChainCallbackManager
  | undefined;

export type LangChainCallbackHandlerOptions<IsAsyncFlush extends boolean> = {
  debug: boolean;
  excludeMetadataProps: RegExp;
  logger?: Logger<IsAsyncFlush> | Span;
  parent?: Span | (() => Span);
};

export type LangChainStartSpanArgs = StartSpanArgs & {
  parentRunId?: string;
  runId: string;
};

export type LangChainEndSpanArgs = ExperimentLogPartialArgs & {
  parentRunId?: string;
  runId: string;
  tags?: string[];
};

export type LangChainLLMResult = {
  generations?: unknown[];
  llmOutput?: Record<string, unknown>;
};
