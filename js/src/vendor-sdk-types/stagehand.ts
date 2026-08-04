/**
 * Minimal structural types for @browserbasehq/stagehand v3.
 *
 * Keep these types limited to the public fields used by instrumentation so the
 * Braintrust SDK does not take a runtime or type dependency on Stagehand.
 */

export type StagehandModel =
  | string
  | {
      modelName?: unknown;
    };

export type StagehandCallOptions = {
  model?: StagehandModel;
};

export type StagehandAction = {
  method?: unknown;
  selector?: unknown;
};

export type StagehandActArguments = [
  input: string | StagehandAction,
  options?: StagehandCallOptions,
];

export type StagehandActResult = {
  success?: unknown;
  actions?: unknown;
  cacheStatus?: unknown;
};

export type StagehandExtractArguments = [
  instructionOrOptions?: string | StagehandCallOptions,
  schemaOrOptions?: unknown,
  options?: StagehandCallOptions,
];

export type StagehandObserveArguments = [
  instructionOrOptions?: string | StagehandCallOptions,
  options?: StagehandCallOptions,
];

export type StagehandObserveResult = unknown[] & {
  cacheStatus?: unknown;
};

export type StagehandAgentConfig = {
  maxSteps?: unknown;
  mode?: unknown;
  model?: StagehandModel;
  stream?: unknown;
};

export type StagehandAgentExecuteOptions = {
  instruction?: unknown;
  output?: unknown;
};

export type StagehandAgentExecuteArguments = [
  instructionOrOptions: string | StagehandAgentExecuteOptions,
];

type StagehandAgentUsage = {
  input_tokens?: unknown;
  output_tokens?: unknown;
  reasoning_tokens?: unknown;
  cached_input_tokens?: unknown;
};

export type StagehandAgentResult = {
  success?: unknown;
  completed?: unknown;
  message?: unknown;
  output?: unknown;
  actions?: unknown;
  metadata?: unknown;
  usage?: StagehandAgentUsage;
};

export type StagehandAgentStreamResult = {
  result?: unknown;
};

export type StagehandAgent = {
  execute: (
    ...args: StagehandAgentExecuteArguments
  ) => Promise<StagehandAgentResult | StagehandAgentStreamResult>;
};

export type StagehandInstance = {
  act: (...args: StagehandActArguments) => Promise<StagehandActResult>;
  extract: (...args: StagehandExtractArguments) => Promise<unknown>;
  observe: (
    ...args: StagehandObserveArguments
  ) => Promise<StagehandObserveResult>;
  agent: (config?: StagehandAgentConfig) => StagehandAgent;
  llmClient?: {
    modelName?: unknown;
  };
};

export type StagehandConstructor = new (
  ...args: unknown[]
) => StagehandInstance;

export type StagehandModule = {
  Stagehand?: StagehandConstructor;
  V3?: StagehandConstructor;
};
