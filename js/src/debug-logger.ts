import iso from "./isomorph";

export type DebugLogLevel = "error" | "warn" | "info" | "debug";
export type DebugLogLevelOption = DebugLogLevel | false | undefined;

type DebugLoggerStateLike = {
  getDebugLogLevel?: () => DebugLogLevel | undefined;
  hasDebugLogLevelOverride?: () => boolean;
};

type DebugLoggerMethods = {
  info: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
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
  return parseDebugLogLevelEnv(iso.getEnv("BRAINTRUST_DEBUG_LOG_LEVEL"));
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

function resolveDebugLogLevel(
  state?: DebugLoggerStateLike,
): DebugLogLevel | undefined {
  const stateLevel = state?.getDebugLogLevel?.();
  const hasStateOverride = state?.hasDebugLogLevelOverride?.() ?? false;
  if (hasStateOverride) {
    return stateLevel;
  }

  const globalLevel =
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    (globalThis as Record<symbol, DebugLogLevel | false | undefined>)[
      DEBUG_LOG_LEVEL_SYMBOL
    ] as DebugLogLevel | false | undefined;

  if (globalLevel !== undefined) {
    return globalLevel === false ? undefined : globalLevel;
  }

  return getEnvDebugLogLevel();
}

function emit(
  method: "info" | "debug" | "warn" | "error",
  state: DebugLoggerStateLike | undefined,
  args: unknown[],
) {
  const level = resolveDebugLogLevel(state);

  if (!level || LOG_LEVEL_PRIORITY[method] > LOG_LEVEL_PRIORITY[level]) {
    return;
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
  };
}

export const debugLogger = {
  ...createDebugLogger(),
  forState(state: DebugLoggerStateLike | undefined): DebugLoggerMethods {
    return createDebugLogger(state);
  },
};
