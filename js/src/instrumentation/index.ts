/**
 * Instrumentation APIs for auto-instrumentation.
 *
 * For auto-instrumentation config types, import InstrumentationConfig from the
 * relevant Braintrust bundler subpath such as `braintrust/vite`.
 *
 * @module instrumentation
 */

export { OpenAIAgentsTraceProcessor } from "./providers/openai-agents-trace-processor";
export type { OpenAIAgentsTraceProcessorOptions } from "./providers/openai-agents-trace-processor";
export { braintrustFlueInstrumentation } from "./providers/flue-instrumentation";
export {
  braintrustEveHook,
  braintrustEveInstrumentation,
} from "./providers/eve-instrumentation";

// Configuration API
export { configureInstrumentation } from "./registry";
export type { InstrumentationConfig } from "./registry";
