import { currentSpan, startSpan, withCurrent, type Span } from "../../logger";
import {
  INSTRUMENTATION_NAMES,
  withSpanInstrumentationName,
} from "../../span-origin";
import { SpanTypeAttribute } from "../../util";
import { observeResult } from "../core/observe-result";
import { isAsyncIterable, patchStreamIfNeeded } from "../core/stream-patcher";

// Span-local ownership works across SDK copies without a process-wide call-ID
// map (call IDs are only unique within an execution).
export const AI_SDK_TOOL_CALL_ID = Symbol.for("braintrust.ai-sdk.tool-call-id");
export const AI_SDK_TOOL_CAPTURE = Symbol.for("braintrust.ai-sdk.tool-capture");
export type AISDKToolSpan = Span & {
  [AI_SDK_TOOL_CALL_ID]?: string;
  [AI_SDK_TOOL_CAPTURE]?: { recordInputs?: boolean; recordOutputs?: boolean };
};

export function currentAISDKToolSpan(toolCallId?: string): Span | undefined {
  const span = currentSpan() as AISDKToolSpan;
  return span.spanId &&
    toolCallId !== undefined &&
    span[AI_SDK_TOOL_CALL_ID] === toolCallId
    ? span
    : undefined;
}

export function traceAISDKTool<T>(
  execute: () => T,
  {
    name,
    input,
    toolCallId,
    parent,
    type = SpanTypeAttribute.TOOL,
    logOutput = (span, output) => span.log({ output }),
  }: {
    name: string;
    input: unknown;
    toolCallId?: string;
    parent?: Span;
    type?: SpanTypeAttribute;
    /** Records the final result; it may log later, after the span has ended. */
    logOutput?: (span: Span, output: unknown) => void;
  },
): T {
  if (currentAISDKToolSpan(toolCallId)) return execute();
  const args = withSpanInstrumentationName(
    {
      name,
      spanAttributes: { type },
    },
    INSTRUMENTATION_NAMES.AI_SDK,
  );
  const span = (
    parent ? parent.startSpan(args) : startSpan(args)
  ) as AISDKToolSpan;
  span[AI_SDK_TOOL_CALL_ID] = toolCallId;
  const captureParent = (parent ?? currentSpan()) as AISDKToolSpan;
  const capture = captureParent.spanId
    ? captureParent[AI_SDK_TOOL_CAPTURE]
    : undefined;
  span[AI_SDK_TOOL_CAPTURE] = capture;
  span.log({
    ...(capture?.recordInputs === false ? {} : { input }),
    metadata: {
      ...(toolCallId === undefined ? {} : { toolCallId }),
    },
  });
  const fail = (error: unknown) => {
    span.log({ error });
    span.end();
  };
  const finish = (output: unknown) => {
    if (capture?.recordOutputs !== false) logOutput(span, output);
    span.end();
  };
  try {
    const result = withCurrent(span, execute);
    return observeResult(
      result,
      (output) => {
        if (isAsyncIterable(output)) {
          let last: unknown;
          patchStreamIfNeeded(output, {
            shouldCollect: (chunk) => {
              last = chunk;
              return false;
            },
            onComplete: () => finish(last),
            onCancel: () => finish(last),
            onError: fail,
            aroundNext: (next) => withCurrent(span, next),
          });
        } else {
          finish(output);
        }
      },
      fail,
    );
  } catch (error) {
    fail(error);
    throw error;
  }
}
