import iso from "./isomorph";
import { setGlobalHookErrorReporter } from "./global-instrumentation-hooks";

export type DebugLogLevel = "error" | "warn" | "info" | "debug";
export type DebugLogLevelOption = DebugLogLevel | false | undefined;

type DebugLoggerStateLike = {
  getDebugLogLevel?: () => DebugLogLevel | undefined;
  hasDebugLogLevelOverride?: () => boolean;
};

// Notice methods return whether the message was emitted.
type NoticeLoggerMethods = {
  warn: (...args: unknown[]) => boolean;
  error: (...args: unknown[]) => boolean;
};

type DebugLoggerMethods = {
  info: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  // User-facing diagnostics that are shown at "warn" when no debug log level
  // has been configured. An explicit level still filters them, and
  // `debugLogLevel: false` silences them.
  notice: NoticeLoggerMethods;
};

const PREFIX = "[braintrust]";
const DEBUG_LOG_LEVEL_SYMBOL = Symbol.for("braintrust-debug-log-level");
const LOG_LEVEL_PRIORITY: Record<DebugLogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

let hasWarnedAboutInvalidEnvValue = false;
let debugLogStateResolver:
  | (() => DebugLoggerStateLike | undefined)
  | undefined = undefined;

function warnInvalidEnvValue(value: string) {
  if (hasWarnedAboutInvalidEnvValue) {
    return;
  }
  hasWarnedAboutInvalidEnvValue = true;
  // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
  console.warn(
    PREFIX,
    `Invalid BRAINTRUST_DEBUG_LOG_LEVEL value "${value}". Expected "error", "warn", "info", or "debug".`,
  );
}

export function normalizeDebugLogLevelOption(
  option: Exclude<DebugLogLevelOption, undefined>,
): DebugLogLevel | undefined {
  if (option === false) {
    return undefined;
  }
  if (
    option === "error" ||
    option === "warn" ||
    option === "info" ||
    option === "debug"
  ) {
    return option;
  }
  throw new Error(
    `Invalid debugLogLevel value "${option}". Expected false, "error", "warn", "info", or "debug".`,
  );
}

function parseDebugLogLevelEnv(
  value: string | undefined,
): DebugLogLevel | undefined {
  if (!value) {
    return undefined;
  }
  if (
    value === "error" ||
    value === "warn" ||
    value === "info" ||
    value === "debug"
  ) {
    return value;
  }
  warnInvalidEnvValue(value);
  return undefined;
}

export function getEnvDebugLogLevel(): DebugLogLevel | undefined {
  return parseDebugLogLevelEnv(
    iso.getEnv("BRAINTRUST_DEBUG_LOG_LEVEL") ??
      // Loader and bundler diagnostics can run before platform initialization.
      (typeof process !== "undefined"
        ? process.env.BRAINTRUST_DEBUG_LOG_LEVEL
        : undefined),
  );
}

export function setGlobalDebugLogLevel(
  level: DebugLogLevel | false | undefined,
): void {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  (globalThis as Record<symbol, DebugLogLevel | false | undefined>)[
    DEBUG_LOG_LEVEL_SYMBOL
  ] = level;
}

export function resetDebugLoggerForTests(): void {
  hasWarnedAboutInvalidEnvValue = false;
  setGlobalDebugLogLevel(undefined);
}

export function setDebugLogStateResolver(
  resolver: (() => DebugLoggerStateLike | undefined) | undefined,
): void {
  debugLogStateResolver = resolver;
}

// Returns `false` when logging was explicitly disabled and `undefined` when no
// level has been configured.
function resolveDebugLogLevel(
  state?: DebugLoggerStateLike,
): DebugLogLevel | false | undefined {
  const stateLevel = state?.getDebugLogLevel?.();
  const hasStateOverride = state?.hasDebugLogLevelOverride?.() ?? false;
  if (hasStateOverride) {
    return stateLevel ?? false;
  }

  const globalLevel =
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    (globalThis as Record<symbol, DebugLogLevel | false | undefined>)[
      DEBUG_LOG_LEVEL_SYMBOL
    ] as DebugLogLevel | false | undefined;

  if (globalLevel !== undefined) {
    return globalLevel;
  }

  return getEnvDebugLogLevel();
}

function emit(
  method: "info" | "debug" | "warn" | "error",
  state: DebugLoggerStateLike | undefined,
  args: unknown[],
  defaultLevel?: DebugLogLevel,
): boolean {
  const level = resolveDebugLogLevel(state) ?? defaultLevel;

  if (!level || LOG_LEVEL_PRIORITY[method] > LOG_LEVEL_PRIORITY[level]) {
    return false;
  }

  if (method === "info") {
    // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
    console.log(PREFIX, ...args);
  } else if (method === "debug") {
    // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
    console.debug(PREFIX, ...args);
  } else if (method === "warn") {
    // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
    console.warn(PREFIX, ...args);
  } else {
    // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
    console.error(PREFIX, ...args);
  }
  return true;
}

function createDebugLogger(state?: DebugLoggerStateLike): DebugLoggerMethods {
  const resolveState = () => state ?? debugLogStateResolver?.();
  return {
    info(...args: unknown[]) {
      emit("info", resolveState(), args);
    },
    debug(...args: unknown[]) {
      emit("debug", resolveState(), args);
    },
    warn(...args: unknown[]) {
      emit("warn", resolveState(), args);
    },
    error(...args: unknown[]) {
      emit("error", resolveState(), args);
    },
    notice: {
      warn(...args: unknown[]) {
        return emit("warn", resolveState(), args, "warn");
      },
      error(...args: unknown[]) {
        return emit("error", resolveState(), args, "warn");
      },
    },
  };
}

export const debugLogger = {
  ...createDebugLogger(),
  forState(state: DebugLoggerStateLike | undefined): DebugLoggerMethods {
    return createDebugLogger(state);
  },
};

setGlobalHookErrorReporter((error) => {
  debugLogger.error("Global instrumentation hook error:", error);
});
