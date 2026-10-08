import { isObject } from "../../../util/index";
import type {
  OpenAIAgentsSpan,
  OpenAIAgentsTrace,
} from "../../vendor-sdk-types/openai-agents";
import { BasePlugin } from "../core";
import { unsubscribeAll } from "../core/channel-tracing";
import { runInstrumentation } from "../core/observe-result";
import { openAIAgentsCoreChannels } from "./openai-agents-channels";
import { OpenAIAgentsTraceProcessor } from "./openai-agents-trace-processor";

function firstArgument(args: unknown): unknown {
  if (Array.isArray(args)) {
    return args[0];
  }
  if (
    isObject(args) &&
    "length" in args &&
    typeof args.length === "number" &&
    Number.isInteger(args.length) &&
    args.length >= 0
  ) {
    return Array.from(args as unknown as ArrayLike<unknown>)[0];
  }
  return undefined;
}

function isOpenAIAgentsTrace(value: unknown): value is OpenAIAgentsTrace {
  return (
    isObject(value) &&
    value.type === "trace" &&
    typeof value.traceId === "string"
  );
}

function isOpenAIAgentsSpan(value: unknown): value is OpenAIAgentsSpan {
  return (
    isObject(value) &&
    value.type === "trace.span" &&
    typeof value.traceId === "string" &&
    typeof value.spanId === "string"
  );
}

export class OpenAIAgentsPlugin extends BasePlugin {
  private processor = new OpenAIAgentsTraceProcessor();

  protected onEnable(): void {
    this.subscribeToTraceLifecycle();
  }

  protected onDisable(): void {
    this.unsubscribers = unsubscribeAll(this.unsubscribers);
    void this.processor.shutdown();
  }

  private subscribeToTraceLifecycle(): void {
    const traceStartChannel = openAIAgentsCoreChannels.onTraceStart;

    const removetraceStartHandlers = traceStartChannel.intercept(
      (target, receiver, args) => {
        runInstrumentation(() =>
          ((event: { arguments: unknown }) => {
            const trace = firstArgument(event.arguments);
            if (isOpenAIAgentsTrace(trace)) {
              void this.processor.onTraceStart(trace);
            }
          })({ arguments: args }),
        );
        return Reflect.apply(target, receiver, args);
      },
    );
    this.unsubscribers.push(removetraceStartHandlers);

    const traceEndChannel = openAIAgentsCoreChannels.onTraceEnd;

    const removetraceEndHandlers = traceEndChannel.intercept(
      (target, receiver, args) => {
        runInstrumentation(() =>
          ((event: { arguments: unknown }) => {
            const trace = firstArgument(event.arguments);
            if (isOpenAIAgentsTrace(trace)) {
              void this.processor.onTraceEnd(trace);
            }
          })({ arguments: args }),
        );
        return Reflect.apply(target, receiver, args);
      },
    );
    this.unsubscribers.push(removetraceEndHandlers);

    const spanStartChannel = openAIAgentsCoreChannels.onSpanStart;

    const removespanStartHandlers = spanStartChannel.intercept(
      (target, receiver, args) => {
        runInstrumentation(() =>
          ((event: { arguments: unknown }) => {
            const span = firstArgument(event.arguments);
            if (isOpenAIAgentsSpan(span)) {
              void this.processor.onSpanStart(span);
            }
          })({ arguments: args }),
        );
        return Reflect.apply(target, receiver, args);
      },
    );
    this.unsubscribers.push(removespanStartHandlers);

    const spanEndChannel = openAIAgentsCoreChannels.onSpanEnd;

    const removespanEndHandlers = spanEndChannel.intercept(
      (target, receiver, args) => {
        runInstrumentation(() =>
          ((event: { arguments: unknown }) => {
            const span = firstArgument(event.arguments);
            if (isOpenAIAgentsSpan(span)) {
              void this.processor.onSpanEnd(span);
            }
          })({ arguments: args }),
        );
        return Reflect.apply(target, receiver, args);
      },
    );
    this.unsubscribers.push(removespanEndHandlers);
  }
}
