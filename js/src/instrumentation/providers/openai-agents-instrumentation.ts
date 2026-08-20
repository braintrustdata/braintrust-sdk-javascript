import { isObject } from "../../../util/index";
import { openAIAgentsCoreChannels } from "./openai-agents-channels";
import { OpenAIAgentsTraceProcessor } from "./openai-agents-trace-processor";
import type {
  OpenAIAgentsSpan,
  OpenAIAgentsTrace,
} from "../../vendor-sdk-types/openai-agents";

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
    const traceStartChannel =
      openAIAgentsCoreChannels.onTraceStart.tracingChannel();
    const traceStartHandlers = {
      start: (event: { arguments: unknown }) => {
        const trace = firstArgument(event.arguments);
        if (isOpenAIAgentsTrace(trace)) {
          void this.processor.onTraceStart(trace);
        }
      },
    };
    traceStartChannel.subscribe(traceStartHandlers);

    const traceEndChannel =
      openAIAgentsCoreChannels.onTraceEnd.tracingChannel();
    const traceEndHandlers = {
      start: (event: { arguments: unknown }) => {
        const trace = firstArgument(event.arguments);
        if (isOpenAIAgentsTrace(trace)) {
          void this.processor.onTraceEnd(trace);
        }
      },
    };
    traceEndChannel.subscribe(traceEndHandlers);

    const spanStartChannel =
      openAIAgentsCoreChannels.onSpanStart.tracingChannel();
    const spanStartHandlers = {
      start: (event: { arguments: unknown }) => {
        const span = firstArgument(event.arguments);
        if (isOpenAIAgentsSpan(span)) {
          void this.processor.onSpanStart(span);
        }
      },
    };
    spanStartChannel.subscribe(spanStartHandlers);

    const spanEndChannel = openAIAgentsCoreChannels.onSpanEnd.tracingChannel();
    const spanEndHandlers = {
      start: (event: { arguments: unknown }) => {
        const span = firstArgument(event.arguments);
        if (isOpenAIAgentsSpan(span)) {
          void this.processor.onSpanEnd(span);
        }
      },
    };
    spanEndChannel.subscribe(spanEndHandlers);
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
