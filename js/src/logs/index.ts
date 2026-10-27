import { currentLogger, type Logger } from "../logger/core";
import iso from "#braintrust-platform";
import { consoleHooks, wrapConsoleMethods } from "./console-interceptor";
import { runConsoleCall, type ConsoleMethod, type LogConsole } from "./console";
import type { ApplicationLogLevel } from "./templates";

function display(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message;
  if (typeof value === "string") return value;
  if (typeof value === "bigint") return String(value);
  return JSON.stringify(value) ?? String(value);
}

function formatConsoleUnsafe(args: unknown[]): string {
  if (iso.formatLogMessage) return iso.formatLogMessage(...args);
  // Browsers expose no API for obtaining their rendered console message. Keep
  // the arguments as text rather than implementing another formatting language.
  // The original console still receives the untouched arguments for rendering.
  return args.map(display).join(" ");
}

function formatConsole(args: unknown[]): string {
  try {
    return formatConsoleUnsafe(args);
  } catch {
    // Console accepts circular objects and objects whose serializers throw.
    return "[Unformattable console message]";
  }
}

/** Forward one console call, keeping message extraction independent of hook registration. */
function forwardConsoleCall(
  call: () => void,
  logger: Logger | undefined,
  method: ConsoleMethod,
  args: unknown[],
): void {
  if (logger) {
    // Browser fallback serialization can invoke toJSON. Reuse each argument's
    // text for the body and metadata so those hooks run only once per argument.
    const formattedArgs = iso.formatLogMessage
      ? undefined
      : args.map((value) => formatConsole([value]));
    const body = formattedArgs ? formattedArgs.join(" ") : formatConsole(args);
    const metadata: Record<string, unknown> = { "logger.name": "console" };
    if (typeof args[0] === "string" && args.length > 1) {
      metadata["braintrust.template"] = args[0];
      args.slice(1).forEach((value, index) => {
        metadata[`braintrust.template.parameter.${index}`] =
          value === null ||
          ["string", "number", "boolean"].includes(typeof value)
            ? value
            : (formattedArgs?.[index + 1] ?? formatConsole([value]));
      });
    }
    const level: ApplicationLogLevel = method === "log" ? "info" : method;
    logger[level](body, { metadata });
  }
  return call();
}

type WrapConsoleOptions = {
  /** Destination for console logs. Defaults to the current project logger at call time. */
  logger?: Logger;
};

const consoleRegistrations = new WeakMap<object, WrapConsoleOptions | null>();
let consoleForwardingEnabled = false;

function enableConsoleForwarding(): void {
  if (consoleForwardingEnabled) return;
  consoleForwardingEnabled = true;
  consoleHooks.write.intercept((target, receiver, args, additional) => {
    const call = () => Reflect.apply(target, receiver, args);
    const registration = consoleRegistrations.get(additional.registration);
    if (registration === undefined) return call();
    // A disabled outer wrapper must not reactivate an older wrapper kept alive
    // by another console patch. Null also releases the destination logger.
    return runConsoleCall((nested) => {
      if (nested || registration === null) return call();
      return forwardConsoleCall(
        call,
        registration.logger ?? currentLogger(),
        additional.method,
        args,
      );
    });
  });
}

/**
 * Instrument future console.log/trace/debug/info/warn/error calls in place.
 * log maps to info; other methods retain their severity. Existing console output
 * is preserved. Repeated calls update the destination without duplicating logs.
 *
 * When no logger is supplied, each call uses the current project logger. Before
 * a logger is initialized, calls produce their normal console output only.
 * Returns an idempotent cleanup function that stops forwarding for this wrap.
 * Cleanup does not disable a later wrap or flush already captured logs.
 *
 * @example
 * const logger = initLogger({ projectName: "application-logs" });
 * const uninstrument = wrapConsole();
 * console.info("Payment %s started", "pay_123");
 * logger.info("Worker started");
 * uninstrument();
 * await logger.flush();
 */
export function wrapConsole(
  target: LogConsole = console,
  options: WrapConsoleOptions = {},
): () => void {
  const registration = {};
  consoleRegistrations.set(registration, { logger: options.logger });
  enableConsoleForwarding();
  wrapConsoleMethods(target, registration);
  return () => {
    // Each wrap owns a distinct token, so stale cleanup cannot disable a newer wrap.
    consoleRegistrations.set(registration, null);
  };
}
