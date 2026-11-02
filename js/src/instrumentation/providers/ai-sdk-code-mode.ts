import { currentSpan, withCurrent, type Span } from "../../logger/core";
import { SpanTypeAttribute } from "../../util";
import type { AISDKRunCodeModeInput } from "../../vendor-sdk-types/ai-sdk-code-mode";
import { isAutoInstrumentationSuppressed } from "../auto-instrumentation-suppression";
import { currentAISDKToolSpan, traceAISDKTool } from "./ai-sdk-tool-tracing";

const CODE_MODE_PARENT = Symbol.for("braintrust.ai-sdk.code-mode-parent");

export function traceAISDKCodeMode<T>(
  execute: (input: AISDKRunCodeModeInput) => T,
  input: AISDKRunCodeModeInput,
): T {
  if (
    isAutoInstrumentationSuppressed() ||
    (input as AISDKRunCodeModeInput & { [CODE_MODE_PARENT]?: Span })[
      CODE_MODE_PARENT
    ]
  ) {
    return execute(input);
  }

  const run = () => {
    const parent = currentSpan();
    // Bind each execution separately: worker-pool callbacks need not inherit
    // the async context of runCodeMode. Never patch the user's shared tools.
    const tools = Object.fromEntries(
      Object.entries(input.tools).map(([name, tool]) => {
        const original = tool.execute;
        if (typeof original !== "function") return [name, tool];
        return [
          name,
          Object.create(tool, {
            execute: {
              value: (
                value: unknown,
                options: Parameters<typeof original>[1],
              ) =>
                withCurrent(parent, () =>
                  traceAISDKTool(
                    () => Reflect.apply(original, tool, [value, options]),
                    {
                      name,
                      input: value,
                      toolCallId: options?.toolCallId,
                      parent,
                      type: SpanTypeAttribute.FUNCTION,
                    },
                  ),
                ),
            },
            ...(typeof tool.needsApproval === "function"
              ? {
                  needsApproval: { value: tool.needsApproval.bind(tool) },
                }
              : {}),
          }),
        ];
      }),
    );
    return execute({ ...input, tools, [CODE_MODE_PARENT]: parent });
  };
  const toolCallId = input.toolExecutionOptions?.toolCallId;
  return currentAISDKToolSpan(toolCallId)
    ? run()
    : traceAISDKTool(run, {
        name: "codeMode",
        input: { js: input.js },
        toolCallId,
      });
}
