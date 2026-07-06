import type { PromptJsonSchema } from "../experimental-prompt-api-schema-utils";
import type {
  PromptDependencies,
  PromptMessage,
} from "../experimental-prompt-api";
import type { BraintrustState } from "../logger";

export type PromptAdapterInput = {
  kind: "messages" | "string";
  model?: string;
  inputSchema: { toJSONSchema(): PromptJsonSchema };
  outputSchema?: { toJSONSchema(): PromptJsonSchema };
  input: unknown;
  messages: PromptMessage[];
  content?: string;
  dependencies: PromptDependencies;
};

export type AdapterOptions = {
  state?: BraintrustState;
};
