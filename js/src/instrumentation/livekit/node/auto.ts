/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions -- structural boundary for the pinned LiveKit/OTel versions. */
import { createRequire } from "node:module";
import { join } from "node:path";
import { currentLogger } from "../../../logger";
import { runtime, observe, setPreparation } from "../runtime";
import type { LiveKitOptions } from "../options";
import { LiveKitSpanProcessor } from "../processor";

const observed = Symbol.for("braintrust.livekit.observed-tracer");

/** Only called by LiveKit's native tracer hooks, never by ordinary SDK startup. */
function prepareLiveKit(
  dynamic: any,
  options: LiveKitOptions,
  allowContent: boolean,
) {
  const active = runtime();
  // A manually installed processor already receives native span callbacks.
  if (active && !active.automatic) return true;
  const logger = currentLogger();
  if (!logger) return false;
  let processor = active as
    | (LiveKitSpanProcessor & { automatic: boolean })
    | undefined;
  const pii = process.env.LIVEKIT_TELEMETRY_ALLOW_PII;
  const content =
    process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
  const captureContent =
    (options.captureContent ?? true) &&
    allowContent &&
    content !== "false" &&
    !["0", "false", "no", "off"].includes(pii?.trim().toLowerCase() ?? "");

  // With no provider configured, use the OTel dependency already installed by
  // LiveKit. Register only against an undelegated API proxy. Existing providers,
  // samplers, processors, and LiveKit Cloud provider setup remain untouched.
  const provider = dynamic.getProvider();
  if (
    typeof provider.getDelegateTracer === "function" &&
    provider.getDelegateTracer("livekit-agents") === undefined
  ) {
    const app = createRequire(join(process.cwd(), "package.json"));
    let entry: string;
    try {
      entry = app.resolve("@opentelemetry/sdk-trace-node");
    } catch {
      entry = createRequire(app.resolve("@livekit/agents")).resolve(
        "@opentelemetry/sdk-trace-node",
      );
    }
    const { NodeTracerProvider } = app(entry);
    const owned = new NodeTracerProvider();
    owned.register();
    process.once("beforeExit", () => {
      void owned.shutdown().catch(() => {});
    });
  }
  if (!processor) {
    processor = Object.assign(
      new LiveKitSpanProcessor({ logger, ...options, captureContent }),
      { automatic: true },
    );
    const owned = processor;
    process.once("beforeExit", () => {
      void owned.shutdown().catch(() => {});
    });
  }
  processor.setContentCapture(captureContent);
  const tracer = dynamic.getTracer();
  if (tracer[observed]) return true;
  const target = processor;
  const track = (span: any) => {
    if (!span.isRecording()) return span;
    observe(() => target.onStart(span));
    const end = span.end;
    let ended = false;
    span.end = function (...args: any[]) {
      try {
        return end.apply(this, args);
      } finally {
        if (!ended) {
          ended = true;
          // Native processors (including LiveKit redaction) see the span first.
          observe(() => target.onEnd(span));
        }
      }
    };
    return span;
  };
  // Decorate only LiveKit's tracer, not the application provider or global API.
  dynamic.tracer = {
    [observed]: true,
    startSpan: (...args: any[]) => track(tracer.startSpan(...args)),
    startActiveSpan: (...args: any[]) => {
      const callback = args[args.length - 1];
      args[args.length - 1] = (span: any) => callback(track(span));
      return tracer.startActiveSpan(...args);
    },
  };
  return true;
}

export function configureLiveKit(): void {
  setPreparation(prepareLiveKit);
}
