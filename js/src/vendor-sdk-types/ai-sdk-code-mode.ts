/** The execution surface of @ai-sdk/code-mode 1.x. */
export interface AISDKCodeModeExecutionOptions {
  toolCallId?: string;
  [key: string]: unknown;
}

export interface AISDKCodeModeTool {
  needsApproval?:
    | boolean
    | ((
        input: unknown,
        options: AISDKCodeModeExecutionOptions,
      ) => boolean | PromiseLike<boolean>);
  execute?: (input: unknown, options: AISDKCodeModeExecutionOptions) => unknown;
  [key: string]: unknown;
}

export interface AISDKRunCodeModeInput {
  js: string;
  tools: Record<string, AISDKCodeModeTool>;
  toolExecutionOptions?: AISDKCodeModeExecutionOptions;
  [key: string]: unknown;
}

export type AISDKRunCodeMode = (
  input: AISDKRunCodeModeInput,
) => Promise<unknown>;
