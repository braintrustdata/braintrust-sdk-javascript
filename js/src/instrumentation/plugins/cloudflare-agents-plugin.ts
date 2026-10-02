import { SpanTypeAttribute } from "../../../util/index";
import { debugLogger } from "../../debug-logger";
import type { Span } from "../../logger";
import { _internalStartSpanWithContext } from "../../logger";
import {
  INSTRUMENTATION_NAMES,
  withSpanInstrumentationName,
} from "../../span-origin";
import { BasePlugin } from "../core";
import { observeResult, runInstrumentation } from "../core/observe-result";

import type { ChannelMessage } from "../core/tracing-types";
import { cloudflareAgentsChannels } from "./cloudflare-agents-channels";

const CLOUDFLARE_WORKERS_CONTEXT = {
  span_origin: {
    environment: { type: "server", name: "cloudflare_workers" },
  },
};

export class CloudflareAgentsPlugin extends BasePlugin {
  protected onEnable(): void {
    const channel = cloudflareAgentsChannels.runAgentTool;
    const spans = new WeakMap<object, Span>();

    const removeHandlers = channel.intercept(
      (target, receiver, args, additional) => {
        const event = {
          ...additional,
          arguments: args,
          self: receiver,
        } as ChannelMessage<typeof cloudflareAgentsChannels.runAgentTool>;
        const prepare = (
          event: ChannelMessage<typeof cloudflareAgentsChannels.runAgentTool>,
        ) => {
          try {
            const agentClass = event.arguments[0];
            const options = event.arguments[1];
            if (ownValue(options, "detached")) {
              return;
            }

            const name = ownValue(agentClass, "name");
            if (typeof name !== "string" || name.length === 0) {
              debugLogger.warn(
                "Skipping Cloudflare Agents runAgentTool span because the child agent class has no name.",
              );
              return;
            }

            const span = _internalStartSpanWithContext(
              withSpanInstrumentationName(
                {
                  name,
                  spanAttributes: { type: SpanTypeAttribute.TOOL },
                  event: {
                    input: ownValue(options, "input"),
                  },
                },
                INSTRUMENTATION_NAMES.CLOUDFLARE_AGENTS,
              ),
              CLOUDFLARE_WORKERS_CONTEXT,
            );
            spans.set(event, span);
          } catch (error) {
            logInstrumentationError("start", error);
          }
        };
        const resolved = (
          event: ChannelMessage<typeof cloudflareAgentsChannels.runAgentTool>,
        ) => {
          const span = spans.get(event);
          if (!span) {
            return;
          }
          spans.delete(event);

          try {
            const status = ownValue(event.result, "status");
            if (status === "completed") {
              span.log({ output: ownValue(event.result, "output") });
            } else {
              const error = ownValue(event.result, "error");
              if (typeof error === "string") {
                span.log({ error });
              }
            }
          } catch (error) {
            logInstrumentationError("completion", error);
          } finally {
            safelyEndSpan(span);
          }
        };
        const failed = (
          event: ChannelMessage<typeof cloudflareAgentsChannels.runAgentTool>,
        ) => {
          const span = spans.get(event);
          if (!span) {
            return;
          }
          spans.delete(event);

          try {
            span.log({ error: event.error });
          } catch (error) {
            logInstrumentationError("rejection", error);
          } finally {
            safelyEndSpan(span);
          }
        };
        runInstrumentation(() => prepare(event));
        let result;
        try {
          result = Reflect.apply(target, receiver, args);
        } catch (error) {
          Object.assign(event, { error });
          runInstrumentation(() => failed(event));
          throw error;
        }
        return observeResult(
          result,
          (value) => {
            Object.assign(event, { result: value });
            resolved(event);
          },
          (error) => {
            Object.assign(event, { error });
            failed(event);
          },
        );
      },
    );
    this.unsubscribers.push(removeHandlers);
  }

  protected onDisable(): void {
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.unsubscribers = [];
  }
}

function ownValue(value: unknown, key: PropertyKey): unknown {
  if (!isObjectLike(value)) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function isObjectLike(value: unknown): value is object {
  return (
    (typeof value === "object" && value !== null) || typeof value === "function"
  );
}

function safelyEndSpan(span: Span): void {
  try {
    span.end();
  } catch (error) {
    logInstrumentationError("span end", error);
  }
}

function logInstrumentationError(operation: string, error: unknown): void {
  debugLogger.error(
    `Failed to process Cloudflare Agents ${operation} instrumentation:`,
    error,
  );
}
