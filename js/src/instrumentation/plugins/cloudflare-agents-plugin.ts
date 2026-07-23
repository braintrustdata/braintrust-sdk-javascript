import { debugLogger } from "../../debug-logger";
import type { IsoChannelHandlers } from "../../isomorph";
import { _internalStartSpanWithContext } from "../../logger";
import type { Span } from "../../logger";
import { mergeSpanOriginContext } from "../../span-origin";
import { SpanTypeAttribute } from "../../../util/index";
import { BasePlugin } from "../core";
import type { ChannelMessage } from "../core/channel-definitions";
import { cloudflareAgentsChannels } from "./cloudflare-agents-channels";

const CLOUDFLARE_WORKERS_ORIGIN = mergeSpanOriginContext(
  undefined,
  "cloudflare-agents",
  { type: "server", name: "cloudflare_workers" },
);

export class CloudflareAgentsPlugin extends BasePlugin {
  protected onEnable(): void {
    const channel = cloudflareAgentsChannels.runAgentTool.tracingChannel();
    const spans = new WeakMap<object, Span>();
    const handlers: IsoChannelHandlers<
      ChannelMessage<typeof cloudflareAgentsChannels.runAgentTool>
    > = {
      start: (event) => {
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
            {
              name,
              spanAttributes: { type: SpanTypeAttribute.TOOL },
              event: {
                input: ownValue(options, "input"),
              },
            },
            CLOUDFLARE_WORKERS_ORIGIN,
          );
          spans.set(event, span);
        } catch (error) {
          logInstrumentationError("start", error);
        }
      },
      asyncEnd: (event) => {
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
      },
      error: (event) => {
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
      },
    };

    channel.subscribe(handlers);
    this.unsubscribers.push(() => channel.unsubscribe(handlers));
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
