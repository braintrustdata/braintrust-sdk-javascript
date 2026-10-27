export const consoleMethods = [
  "log",
  "trace",
  "debug",
  "info",
  "warn",
  "error",
] as const;
export type ConsoleMethod = (typeof consoleMethods)[number];
export type LogConsole = Pick<Console, ConsoleMethod>;

const CONSOLE_STATE = Symbol.for("braintrust.consoleState");
type ConsoleState = {
  originals: WeakMap<LogConsole, LogConsole>;
  inConsoleCall: boolean;
};

function state(): ConsoleState {
  // Share originals and the synchronous reentrancy guard across SDK copies.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const global = globalThis as typeof globalThis & {
    [CONSOLE_STATE]?: ConsoleState;
  };
  return (global[CONSOLE_STATE] ??= {
    originals: new WeakMap(),
    inConsoleCall: false,
  });
}

export function saveConsoleMethods(target: LogConsole): void {
  const { originals } = state();
  if (originals.has(target)) return;
  originals.set(target, {
    log: target.log,
    trace: target.trace,
    debug: target.debug,
    info: target.info,
    warn: target.warn,
    error: target.error,
  });
}

/** Only the outermost synchronous console call should be captured. */
export function runConsoleCall<R>(callback: (nested: boolean) => R): R {
  const current = state();
  const nested = current.inConsoleCall;
  current.inConsoleCall = true;
  try {
    return callback(nested);
  } finally {
    current.inConsoleCall = nested;
  }
}

function writeOriginal(method: ConsoleMethod, args: unknown[]): void {
  const original = (state().originals.get(console) ?? console)[method];
  runConsoleCall(() => Reflect.apply(original, console, args));
}

/** SDK-owned output bypasses Braintrust's console wrappers. */
export const sdkConsole: LogConsole = {
  log: (...args) => writeOriginal("log", args),
  trace: (...args) => writeOriginal("trace", args),
  debug: (...args) => writeOriginal("debug", args),
  info: (...args) => writeOriginal("info", args),
  warn: (...args) => writeOriginal("warn", args),
  error: (...args) => writeOriginal("error", args),
};
