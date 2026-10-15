import { isObject, SpanTypeAttribute } from "../../../util/index";
import { BasePlugin } from "../core";
import {
  traceAsyncChannel,
  traceStreamingChannel,
  unsubscribeAll,
} from "../core/channel-tracing";
import { e2bChannels, e2bCodeInterpreterChannels } from "./e2b-channels";

// Select public operation data instead of serializing connection options,
// callbacks, environment variables, or credential-bearing SDK instances.
function fields(value: unknown, keys: string[]): Record<string, unknown> {
  if (!isObject(value)) return {};
  return Object.fromEntries(
    keys
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, value[key]]),
  );
}

export class E2BPlugin extends BasePlugin {
  protected onEnable(): void {
    this.unsubscribers.push(
      traceAsyncChannel(e2bChannels.create, {
        name: "e2b.Sandbox.create",
        type: SpanTypeAttribute.TOOL,
        extractInput: ([templateOrOptions, options]) => ({
          input: {
            ...(typeof templateOrOptions === "string"
              ? { template: templateOrOptions }
              : {}),
            ...fields(
              typeof templateOrOptions === "string"
                ? options
                : templateOrOptions,
              ["timeoutMs"],
            ),
          },
          metadata: { provider: "e2b" },
        }),
        extractOutput: (result) => fields(result, ["sandboxId"]),
        extractMetrics: () => ({}),
      }),
      traceAsyncChannel(e2bChannels.run, {
        name: "e2b.commands.run",
        type: SpanTypeAttribute.TOOL,
        extractInput: ([command, options]) => ({
          input: { command },
          metadata: {
            provider: "e2b",
            ...fields(options, ["cwd", "user", "background", "timeoutMs"]),
          },
        }),
        // Background calls return a CommandHandle, not a finished command.
        extractOutput: (result) =>
          fields(result, ["pid", "stdout", "stderr", "exitCode"]),
        extractMetrics: () => ({}),
      }),
      traceStreamingChannel(e2bCodeInterpreterChannels.runCode, {
        name: "e2b.runCode",
        type: SpanTypeAttribute.TOOL,
        extractInput: ([code, options], event) => ({
          input: { code },
          metadata: {
            provider: "e2b",
            ...fields(event.self, ["sandboxId"]),
            ...fields(options, ["language", "timeoutMs"]),
            ...(isObject(options) && isObject(options.context)
              ? { context: fields(options.context, ["id", "language"]) }
              : {}),
          },
        }),
        extractOutput: (result) => fields(result, ["logs", "results", "error"]),
        extractMetrics: () => ({}),
        onComplete: ({ result, span }) => {
          // Execution errors resolve successfully at the HTTP layer.
          if (isObject(result) && isObject(result.error)) {
            const { name, value, traceback } = result.error;
            span.log({
              error:
                typeof traceback === "string" && traceback
                  ? traceback
                  : `${String(name ?? "ExecutionError")}: ${String(value ?? "")}`,
            });
          }
        },
      }),
    );
  }

  protected onDisable(): void {
    this.unsubscribers = unsubscribeAll(this.unsubscribers);
  }
}
