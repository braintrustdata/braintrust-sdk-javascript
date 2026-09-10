/// <reference lib="dom" />

import { currentLogger, type Logger } from "../logger";

const CONSOLE_LEVELS = [
  "debug",
  "info",
  "warn",
  "error",
  "log",
  "trace",
  "assert",
] as const;

type ConsoleLevel = (typeof CONSOLE_LEVELS)[number];
type ConsoleLogger = Logger<boolean>;

type ConsoleInstrumentationOptions = {
  /** Console methods to capture. Defaults to all supported methods. */
  levels?: readonly ConsoleLevel[];
  /** Logger that receives console records. Defaults to the current logger. */
  logger?: ConsoleLogger;
};

type ConsoleHandler = {
  levels: Set<ConsoleLevel>;
  logger: ConsoleLogger | undefined;
  references: number;
};

type ConsoleInstrumentationState = {
  handlers: ConsoleHandler[];
  originals: Map<ConsoleLevel, (...args: unknown[]) => unknown>;
  wrappers: Map<ConsoleLevel, (...args: unknown[]) => unknown>;
  forwarding: boolean;
  callingOriginal: boolean;
};

const CONSOLE_INSTRUMENTATION_STATE = Symbol.for(
  "braintrust.console-instrumentation.v1",
);

function getState(): ConsoleInstrumentationState {
  const globalObject = globalThis as typeof globalThis & {
    [CONSOLE_INSTRUMENTATION_STATE]?: ConsoleInstrumentationState;
  };
  globalObject[CONSOLE_INSTRUMENTATION_STATE] ??= {
    handlers: [],
    originals: new Map(),
    wrappers: new Map(),
    forwarding: false,
    callingOriginal: false,
  };
  return globalObject[CONSOLE_INSTRUMENTATION_STATE];
}

function isConsoleLevel(value: string): value is ConsoleLevel {
  return (CONSOLE_LEVELS as readonly string[]).includes(value);
}

function normalizeLevels(
  levels: readonly ConsoleLevel[] | undefined,
): Set<ConsoleLevel> {
  if (levels === undefined) {
    return new Set(CONSOLE_LEVELS);
  }
  return new Set(levels.filter(isConsoleLevel));
}

function levelsMatch(
  left: Set<ConsoleLevel>,
  right: Set<ConsoleLevel>,
): boolean {
  return (
    left.size === right.size &&
    Array.from(left).every((level) => right.has(level))
  );
}

function safeFormatValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Error) {
    return value.stack ?? value.message;
  }
  if (value === null || typeof value !== "object") {
    try {
      return String(value);
    } catch {
      return "[Unserializable]";
    }
  }

  const seen = new WeakSet<object>();
  try {
    const serialized = JSON.stringify(value, (_key, nestedValue: unknown) => {
      if (typeof nestedValue === "bigint") {
        return String(nestedValue);
      }
      if (typeof nestedValue === "object" && nestedValue !== null) {
        if (seen.has(nestedValue)) {
          return "[Circular]";
        }
        seen.add(nestedValue);
      }
      return nestedValue;
    });
    return serialized ?? String(value);
  } catch {
    try {
      return String(value);
    } catch {
      return "[Unserializable]";
    }
  }
}

function formatConsoleArgs(args: unknown[]): string {
  if (args.length === 0) {
    return "";
  }

  const [first, ...following] = args;
  if (typeof first !== "string") {
    return args.map(safeFormatValue).join(" ");
  }

  let nextArgument = 0;
  const formatted = first.replace(
    /%([%sdifjoOc])/g,
    (placeholder, specifier: string) => {
      if (specifier === "%") {
        return "%";
      }
      if (nextArgument >= following.length) {
        return placeholder;
      }

      const value = following[nextArgument++];
      switch (specifier) {
        case "d":
        case "i":
          return String(Number.parseInt(String(value), 10));
        case "f":
          return String(Number.parseFloat(String(value)));
        case "c":
          return "";
        default:
          return safeFormatValue(value);
      }
    },
  );

  const remaining = following.slice(nextArgument).map(safeFormatValue);
  return [formatted, ...remaining].join(" ");
}

function ignoreRejectedLog(result: unknown): void {
  if (
    typeof result === "object" &&
    result !== null &&
    "then" in result &&
    typeof result.then === "function"
  ) {
    void Promise.resolve(result).catch(() => undefined);
  }
}

function forwardConsoleCall(
  logger: ConsoleLogger,
  level: ConsoleLevel,
  args: unknown[],
): void {
  if (level === "assert") {
    const [condition, ...messageArgs] = args;
    if (condition) {
      return;
    }
    const message =
      messageArgs.length === 0
        ? "Assertion failed"
        : `Assertion failed: ${formatConsoleArgs(messageArgs)}`;
    ignoreRejectedLog(logger.error(message));
    return;
  }

  const body = formatConsoleArgs(args);
  switch (level) {
    case "log":
      ignoreRejectedLog(logger.info(body));
      break;
    case "debug":
      ignoreRejectedLog(logger.debug(body));
      break;
    case "info":
      ignoreRejectedLog(logger.info(body));
      break;
    case "warn":
      ignoreRejectedLog(logger.warn(body));
      break;
    case "error":
      ignoreRejectedLog(logger.error(body));
      break;
    case "trace":
      ignoreRejectedLog(logger.trace(body));
      break;
  }
}

function notifyHandlers(level: ConsoleLevel, args: unknown[]): void {
  const state = getState();
  if (state.forwarding) {
    return;
  }

  state.forwarding = true;
  try {
    for (const handler of [...state.handlers]) {
      if (!handler.levels.has(level)) {
        continue;
      }
      const logger = handler.logger ?? currentLogger<boolean>();
      if (!logger) {
        continue;
      }
      try {
        forwardConsoleCall(logger, level, args);
      } catch {
        // Console instrumentation must never affect the original call.
      }
    }
  } finally {
    state.forwarding = false;
  }
}

function patchConsole(): void {
  if (!("console" in globalThis)) {
    return;
  }

  const state = getState();
  for (const level of CONSOLE_LEVELS) {
    if (state.wrappers.has(level)) {
      continue;
    }

    const consoleMethod = globalThis.console[level];
    if (typeof consoleMethod !== "function") {
      continue;
    }
    const original = consoleMethod as unknown as (
      ...args: unknown[]
    ) => unknown;

    const wrapper = function (this: Console, ...args: unknown[]): unknown {
      if (!state.callingOriginal) {
        notifyHandlers(level, args);
      }

      const wasCallingOriginal = state.callingOriginal;
      state.callingOriginal = true;
      try {
        return original.apply(this, args);
      } finally {
        state.callingOriginal = wasCallingOriginal;
      }
    };

    try {
      globalThis.console[level] = wrapper as never;
      state.originals.set(level, original);
      state.wrappers.set(level, wrapper);
    } catch {
      // Some runtimes expose non-writable console methods. Leave those alone.
    }
  }
}

/**
 * Capture calls to the console API as Braintrust log records.
 *
 * This instrumentation is opt-in and leaves the original console behavior
 * unchanged. By default it captures `debug`, `info`, `warn`, `error`, `log`,
 * `trace`, and failed `assert` calls. Calling the function repeatedly with the
 * same logger and levels is idempotent.
 *
 * @returns A function that stops forwarding calls for this registration.
 *
 * @example
 * ```ts
 * const logger = initLogger({ projectName: "my-project" });
 * const stop = instrumentConsole({ logger, levels: ["warn", "error"] });
 * ```
 */
export function instrumentConsole(
  options: ConsoleInstrumentationOptions = {},
): () => void {
  const state = getState();
  const levels = normalizeLevels(options.levels);
  let handler = state.handlers.find(
    (candidate) =>
      candidate.logger === options.logger &&
      levelsMatch(candidate.levels, levels),
  );

  if (handler) {
    handler.references++;
  } else {
    handler = {
      levels,
      logger: options.logger,
      references: 1,
    };
    state.handlers.push(handler);
  }
  patchConsole();

  let active = true;
  return () => {
    if (!active || !handler) {
      return;
    }
    active = false;
    handler.references--;
    if (handler.references === 0) {
      const index = state.handlers.indexOf(handler);
      if (index !== -1) {
        state.handlers.splice(index, 1);
      }
    }
  };
}

/** Restore console methods and clear handlers. For tests only. */
export function _resetConsoleInstrumentationForTests(): void {
  const state = getState();
  for (const [level, original] of state.originals) {
    if (globalThis.console[level] === state.wrappers.get(level)) {
      globalThis.console[level] = original as never;
    }
  }
  state.handlers.length = 0;
  state.originals.clear();
  state.wrappers.clear();
  state.forwarding = false;
  state.callingOriginal = false;
}
