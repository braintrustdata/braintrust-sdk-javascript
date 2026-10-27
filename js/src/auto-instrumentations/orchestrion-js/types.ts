/*
 * Forked from @apm-js-collab/code-transformer@0.12.0 (Orchestrion-JS),
 * licensed under Apache-2.0. Modified by Braintrust.
 */

/**
 * Output of a transformation operation.
 */
export interface TransformOutput {
  /**
   * The transformed JavaScript code.
   */
  code: string;

  /**
   * The sourcemap for the transformation, if generated.
   */
  map?: string;
}

/**
 * Describes which function to instrument.
 */
export type FunctionQuery = {
  index?: number;
} & (
  | {
      className: string;
      methodName: string;
      isExportAlias?: boolean;
    }
  | { methodName: string }
  | {
      functionName: string;
      isExportAlias?: boolean;
    }
  | { propertyName: string }
);

/**
 * Configuration for injecting instrumentation code.
 */
export interface InstrumentationConfig {
  /**
   * The name of the global instrumentation hook to invoke.
   */
  channelName: string;

  /**
   * The module matcher to identify the module and file to instrument.
   */
  module: ModuleMatcher;

  /**
   * The function query to identify the function to instrument.
   */
  functionQuery: FunctionQuery;
}

/**
 * Describes the module and file path you would like to match.
 */
export interface ModuleMatcher {
  /**
   * The name of the module you want to match.
   */
  name: string;

  /**
   * The semver range that you want to match.
   */
  versionRange: string;

  /**
   * The path of the file you want to match from the module root.
   */
  filePath: string;
}

/**
 * The type of module being passed: ESM, CJS, or unknown.
 */
export type ModuleType = "esm" | "cjs" | "unknown";
