/**
 * Minimal structural types for @browserbasehq/stagehand v3.
 *
 * Keep these types limited to the public fields used by instrumentation so the
 * Braintrust SDK does not take a runtime or type dependency on Stagehand.
 */

export type StagehandAction = {
  method?: unknown;
};

export type StagehandActResult = {
  success?: unknown;
  actions?: unknown;
  cacheStatus?: unknown;
};

export type StagehandAgentUsage = {
  input_tokens?: unknown;
  output_tokens?: unknown;
  reasoning_tokens?: unknown;
  cached_input_tokens?: unknown;
};

export type StagehandAgentAction = {
  type?: unknown;
  taskCompleted?: unknown;
  task_completed?: unknown;
  timeMs?: unknown;
  time_ms?: unknown;
};

export type StagehandAgentResult = {
  success?: unknown;
  completed?: unknown;
  message?: unknown;
  output?: unknown;
  actions?: unknown;
  metadata?: unknown;
  usage?: StagehandAgentUsage | unknown;
};

export type StagehandAgentStreamResult = {
  result?: unknown;
};

export type StagehandAgent = {
  execute: (...args: unknown[]) => Promise<StagehandAgentResult | unknown>;
};

export type StagehandInstance = {
  act: (...args: unknown[]) => Promise<StagehandActResult | unknown>;
  extract: (...args: unknown[]) => Promise<unknown>;
  observe: (...args: unknown[]) => Promise<unknown>;
  agent: (...args: unknown[]) => StagehandAgent | unknown;
};

export type StagehandConstructor = new (
  ...args: unknown[]
) => StagehandInstance;

export type StagehandModule = {
  Stagehand?: StagehandConstructor;
  V3?: StagehandConstructor;
};
