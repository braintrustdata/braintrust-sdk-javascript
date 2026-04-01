import { warning } from "../../framework";
import type { CommonArgs } from "./types";

export const VERBOSE_DEPRECATION_MESSAGE =
  "--verbose is deprecated and will be removed in a future version of braintrust. Use --debug-logging debug to see full stack traces and troubleshooting details.";

let hasWarnedAboutVerboseFlag = false;

export function shouldShowDetailedErrors(
  debugLogLevel: CommonArgs["debug_logging"] | undefined,
): boolean {
  return debugLogLevel === "debug";
}

export function normalizeDebugLoggingArgs<
  T extends Pick<CommonArgs, "verbose" | "debug_logging">,
>(args: T): T {
  if (!args.verbose) {
    return args;
  }

  if (!hasWarnedAboutVerboseFlag) {
    hasWarnedAboutVerboseFlag = true;
    // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
    console.warn(warning(VERBOSE_DEPRECATION_MESSAGE));
  }

  if (!args.debug_logging) {
    args.debug_logging = "debug";
  }

  return args;
}

export function resetDebugLoggingArgsForTests(): void {
  hasWarnedAboutVerboseFlag = false;
}
