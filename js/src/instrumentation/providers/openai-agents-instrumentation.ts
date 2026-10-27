import { isObject } from "../../../util/index";
import type {
  OpenAIAgentsSpan,
  OpenAIAgentsTrace,
} from "../../vendor-sdk-types/openai-agents";

import { runInstrumentation } from "../core/observe-result";
import { openAIAgentsCoreChannels } from "./openai-agents-interceptors";
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

class OpenAIAgentsInstrumentationConsumer {
  private processor = new OpenAIAgentsTraceProcessor();

  public register(): void {
    this.subscribeToTraceLifecycle();
  }

  private subscribeToTraceLifecycle(): void {
    const traceStartChannel = openAIAgentsCoreChannels.onTraceStart;

    traceStartChannel.intercept((target, receiver, args) => {
      runInstrumentation(() =>
        ((event: { arguments: unknown }) => {
          const trace = firstArgument(event.arguments);
          if (isOpenAIAgentsTrace(trace)) {
            void this.processor.onTraceStart(trace);
          }
        })({ arguments: args }),
      );
      return Reflect.apply(target, receiver, args);
    });

    const traceEndChannel = openAIAgentsCoreChannels.onTraceEnd;

    traceEndChannel.intercept((target, receiver, args) => {
      runInstrumentation(() =>
        ((event: { arguments: unknown }) => {
          const trace = firstArgument(event.arguments);
          if (isOpenAIAgentsTrace(trace)) {
            void this.processor.onTraceEnd(trace);
          }
        })({ arguments: args }),
      );
      return Reflect.apply(target, receiver, args);
    });

    const spanStartChannel = openAIAgentsCoreChannels.onSpanStart;

    spanStartChannel.intercept((target, receiver, args) => {
      runInstrumentation(() =>
        ((event: { arguments: unknown }) => {
          const span = firstArgument(event.arguments);
          if (isOpenAIAgentsSpan(span)) {
            void this.processor.onSpanStart(span);
          }
        })({ arguments: args }),
      );
      return Reflect.apply(target, receiver, args);
    });

    const spanEndChannel = openAIAgentsCoreChannels.onSpanEnd;

    spanEndChannel.intercept((target, receiver, args) => {
      runInstrumentation(() =>
        ((event: { arguments: unknown }) => {
          const span = firstArgument(event.arguments);
          if (isOpenAIAgentsSpan(span)) {
            void this.processor.onSpanEnd(span);
          }
        })({ arguments: args }),
      );
      return Reflect.apply(target, receiver, args);
    });
  }
}

let openAIAgentsInstrumentationConsumer:
  | OpenAIAgentsInstrumentationConsumer
  | undefined;

export function registerOpenAIAgentsInstrumentation(): void {
  openAIAgentsInstrumentationConsumer ??=
    new OpenAIAgentsInstrumentationConsumer();
  openAIAgentsInstrumentationConsumer.register();
}
