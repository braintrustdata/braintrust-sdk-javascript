/**
 * Import verification test suite
 *
 * Based on actual exports from src/exports.ts
 *
 * This suite explicitly checks that major Braintrust runtime exports exist.
 * By importing and verifying these exports, we force bundlers to process
 * the full export graph, preventing tree-shaking false positives where
 * "unused" exports might be removed even though they should be available.
 *
 * Note: This only tests RUNTIME VALUE exports (functions, classes, objects).
 * TypeScript type-only exports (interfaces, types) don't exist at runtime
 * and are not tested here.
 *
 * Tests are categorized as:
 * - Required: Must exist in ALL builds (browser and node)
 * - Optional: May not exist depending on build configuration
 */

import { assertType, assertDefined } from "../helpers/assertions";
import { register, type TestFn } from "../helpers/register";

/**
 * Interface for the Braintrust module based on exports.ts
 */
export interface BraintrustModule {
  __publicModule?: BraintrustModule;
  // Core logging (REQUIRED)
  initLogger?: unknown;
  Logger?: unknown;
  currentLogger?: unknown;
  currentSpan?: unknown;
  Span?: unknown;
  SpanImpl?: unknown;
  startSpan?: unknown;
  log?: unknown;
  flush?: unknown;

  // Datasets (REQUIRED)
  initDataset?: unknown;
  Dataset?: unknown;

  // Experiments (REQUIRED)
  initExperiment?: unknown;
  Experiment?: unknown;
  currentExperiment?: unknown;
  ReadonlyExperiment?: unknown;

  // Prompts (REQUIRED)
  loadPrompt?: unknown;
  Prompt?: unknown;
  getPromptVersions?: unknown;

  // Evaluations (REQUIRED - runtime values only)
  Eval?: unknown;
  EvalResultWithSummary?: unknown;
  Reporter?: unknown;
  defaultErrorScoreHandler?: unknown;

  // Tracing (REQUIRED)
  traced?: unknown;
  traceable?: unknown;
  wrapTraced?: unknown;
  LocalTrace?: unknown;
  updateSpan?: unknown;
  withCurrent?: unknown;

  // Client wrappers (wrapOpenAI is REQUIRED, others optional)
  wrapOpenAI?: unknown;
  wrapAnthropic?: unknown;
  wrapGoogleGenAI?: unknown;
  wrapAISDK?: unknown;
  wrapMastraAgent?: unknown;
  wrapClaudeAgentSDK?: unknown;

  // Utilities (REQUIRED)
  JSONAttachment?: unknown;
  Attachment?: unknown;
  newId?: unknown;
  permalink?: unknown;

  // Functions (REQUIRED)
  invoke?: unknown;
  initFunction?: unknown;

  // Framework2 - Programmatic prompt/function creation (REQUIRED)
  Project?: unknown;
  projects?: unknown;
  PromptBuilder?: unknown;

  // Legacy private smoke-test harness fields
  IDGenerator?: unknown;
  _exportsForTestingOnly?: unknown;

  // State management (REQUIRED)
  BraintrustState?: unknown;
  login?: unknown;

  [key: string]: unknown;
}

export const testCoreLoggingExports = register(
  "testCoreLoggingExports",
  async (module) => {
    assertDefined(module.initLogger, "initLogger must exist");
    assertType(module.initLogger, "function", "initLogger must be a function");

    assertDefined(module.Logger, "Logger must exist");
    assertType(module.Logger, "function", "Logger must be a function/class");

    assertDefined(module.currentLogger, "currentLogger must exist");
    assertType(
      module.currentLogger,
      "function",
      "currentLogger must be a function",
    );

    assertDefined(module.currentSpan, "currentSpan must exist");
    assertType(
      module.currentSpan,
      "function",
      "currentSpan must be a function",
    );

    assertDefined(module.startSpan, "startSpan must exist");
    assertType(module.startSpan, "function", "startSpan must be a function");

    assertDefined(module.flush, "flush must exist");
    assertType(module.flush, "function", "flush must be a function");

    const publicModule = module.__publicModule ?? module;
    for (const removed of [
      "default",
      "log",
      "summarize",
      "initExperiment",
      "traceable",
      "EvalResultWithSummary",
      "SpanImpl",
      "_exportsForTestingOnly",
      "AttachmentReference",
      "promptDefinitionSchema",
      "braintrustEveInstrumentation",
      "braintrustFlueInstrumentation",
    ]) {
      if (removed in publicModule) {
        throw new Error(`${removed} must not be publicly exported`);
      }
    }

    return "Core logging exports and removals verified";
  },
);

export const testDatasetExports = register(
  "testDatasetExports",
  async (module) => {
    assertDefined(module.initDataset, "initDataset must exist");
    assertType(
      module.initDataset,
      "function",
      "initDataset must be a function",
    );

    assertDefined(module.Dataset, "Dataset must exist");
    assertType(module.Dataset, "function", "Dataset must be a function/class");

    return "Dataset exports verified (2 exports)";
  },
);

export const testPromptExports = register(
  "testPromptExports",
  async (module) => {
    assertDefined(module.loadPrompt, "loadPrompt must exist");
    assertType(module.loadPrompt, "function", "loadPrompt must be a function");

    assertDefined(module.Prompt, "Prompt must exist");
    assertType(module.Prompt, "function", "Prompt must be a function/class");

    assertDefined(module.getPromptVersions, "getPromptVersions must exist");
    assertType(
      module.getPromptVersions,
      "function",
      "getPromptVersions must be a function",
    );

    return "Prompt exports verified (3 exports)";
  },
);

export const testExperimentExports = register(
  "testExperimentExports",
  async (module) => {
    assertDefined(module.init, "init must exist");
    assertType(module.init, "function", "init must be a function");

    assertDefined(module.Experiment, "Experiment must exist");
    assertType(
      module.Experiment,
      "function",
      "Experiment must be a function/class",
    );

    assertDefined(module.currentExperiment, "currentExperiment must exist");
    assertType(
      module.currentExperiment,
      "function",
      "currentExperiment must be a function",
    );

    return "Experiment exports verified (3 exports)";
  },
);

export const testEvalExports = register("testEvalExports", async (module) => {
  assertDefined(module.Eval, "Eval must exist");
  assertType(module.Eval, "function", "Eval must be a function");

  assertDefined(module.Reporter, "Reporter must exist");
  assertType(module.Reporter, "function", "Reporter must be a function");

  assertDefined(
    module.defaultErrorScoreHandler,
    "defaultErrorScoreHandler must exist",
  );
  assertType(
    module.defaultErrorScoreHandler,
    "function",
    "defaultErrorScoreHandler must be a function",
  );

  return "Eval exports verified (3 runtime exports)";
});

export const testTracingExports = register(
  "testTracingExports",
  async (module) => {
    assertDefined(module.traced, "traced must exist");
    assertType(module.traced, "function", "traced must be a function");

    assertDefined(module.wrapTraced, "wrapTraced must exist");
    assertType(module.wrapTraced, "function", "wrapTraced must be a function");

    assertDefined(module.LocalTrace, "LocalTrace must exist");
    assertType(
      module.LocalTrace,
      "function",
      "LocalTrace must be a function/class",
    );

    assertDefined(module.updateSpan, "updateSpan must exist");
    assertType(module.updateSpan, "function", "updateSpan must be a function");

    assertDefined(module.withCurrent, "withCurrent must exist");
    assertType(
      module.withCurrent,
      "function",
      "withCurrent must be a function",
    );

    return "Tracing exports verified (5 exports)";
  },
);

export const testClientWrapperExports = register(
  "testClientWrapperExports",
  async (module) => {
    assertDefined(module.wrapOpenAI, "wrapOpenAI must exist");
    assertType(module.wrapOpenAI, "function", "wrapOpenAI must be a function");

    let optionalCount = 0;
    const optionalWrappers = [
      "wrapAnthropic",
      "wrapGoogleGenAI",
      "wrapOpenRouter",
      "wrapAISDK",
      "wrapClaudeAgentSDK",
    ];

    for (const wrapper of optionalWrappers) {
      if (wrapper in module && module[wrapper]) {
        assertType(
          module[wrapper],
          "function",
          `${wrapper} must be a function`,
        );
        optionalCount++;
      }
    }

    return `Client wrapper exports verified (1 required + ${optionalCount} optional)`;
  },
);

export const testUtilityExports = register(
  "testUtilityExports",
  async (module) => {
    assertDefined(module.JSONAttachment, "JSONAttachment must exist");
    assertType(
      module.JSONAttachment,
      "function",
      "JSONAttachment must be a function/class",
    );

    assertDefined(module.Attachment, "Attachment must exist");
    assertType(
      module.Attachment,
      "function",
      "Attachment must be a function/class",
    );

    return "Attachment exports verified (2 exports)";
  },
);

export const testFunctionExports = register(
  "testFunctionExports",
  async (module) => {
    assertDefined(module.invoke, "invoke must exist");
    assertType(module.invoke, "function", "invoke must be a function");

    assertDefined(module.initFunction, "initFunction must exist");
    assertType(
      module.initFunction,
      "function",
      "initFunction must be a function",
    );

    return "Function exports verified (2 exports)";
  },
);

export const testFramework2Exports = register(
  "testFramework2Exports",
  async (module) => {
    assertDefined(module.projects, "projects must exist");
    assertType(module.projects, "object", "projects must be an object");

    return "Project facade export verified";
  },
);

export const testIDGeneratorExports = register(
  "testIDGeneratorExports",
  async (module) => {
    assertDefined(module.IDGenerator, "IDGenerator must exist");
    assertType(
      module.IDGenerator,
      "function",
      "IDGenerator must be a function/class",
    );

    return "Internal ID generator export verified";
  },
  { requiresTestHarness: true },
);

export const testTestingExports = register(
  "testTestingExports",
  async (module) => {
    assertDefined(
      module._exportsForTestingOnly,
      "_exportsForTestingOnly must exist",
    );
    assertType(
      module._exportsForTestingOnly,
      "object",
      "_exportsForTestingOnly must be an object",
    );

    return "Internal testing export verified";
  },
  { requiresTestHarness: true },
);

export const testStateManagementExports = register(
  "testStateManagementExports",
  async (module) => {
    assertDefined(module.BraintrustState, "BraintrustState must exist");
    assertType(
      module.BraintrustState,
      "function",
      "BraintrustState must be a function/class",
    );

    assertDefined(module.login, "login must exist");
    assertType(module.login, "function", "login must be a function");

    return "State management exports verified (2 exports)";
  },
);

export function testBuildResolution(
  expectedBuildType?:
    | "browser"
    | "browser-js"
    | "edge-light"
    | "workerd"
    | "node",
): TestFn {
  return register(
    "testBuildResolution",
    async (module) => {
      const { buildType: detectedBuild, buildDetails } =
        detectBuildType(module);
      const detectedFormat = detectModuleFormat();

      if (detectedBuild === "unknown") {
        throw new Error(
          `Build type is unknown - configureBrowser() or configureNode() was not called. ${buildDetails || ""}`,
        );
      }

      if (expectedBuildType && detectedBuild !== expectedBuildType) {
        throw new Error(
          `Expected build type "${expectedBuildType}" but detected "${detectedBuild}"`,
        );
      }

      const parts: string[] = [`Detected ${detectedBuild} build`];

      if (expectedBuildType) {
        parts.push(`(expected: ${expectedBuildType})`);
      }

      if (detectedFormat !== "unknown") {
        parts.push(`${detectedFormat} format`);
      }

      return parts.join(", ");
    },
    { requiresTestHarness: true },
  );
}

function detectBuildType(module: BraintrustModule): {
  buildType:
    | "browser"
    | "browser-js"
    | "edge-light"
    | "workerd"
    | "node"
    | "unknown";
  buildDetails: string;
} {
  if (!module._exportsForTestingOnly) {
    return {
      buildType: "unknown",
      buildDetails: "_exportsForTestingOnly not available",
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const testing = module._exportsForTestingOnly as any;
  const iso = testing.isomorph;

  if (!iso || typeof iso !== "object") {
    return {
      buildType: "unknown",
      buildDetails: "isomorph not available in testing exports",
    };
  }

  const buildType = iso.buildType;
  if (
    buildType === "browser" ||
    buildType === "browser-js" ||
    buildType === "edge-light" ||
    buildType === "workerd" ||
    buildType === "node" ||
    buildType === "unknown"
  ) {
    return {
      buildType,
      buildDetails: `Build type from isomorph.buildType: ${buildType}`,
    };
  }

  return {
    buildType: "unknown",
    buildDetails: `isomorph.buildType has unexpected value: ${buildType}`,
  };
}

function detectModuleFormat(): "cjs" | "esm" | "unknown" {
  const packageSpec = "braintrust";
  try {
    if (
      typeof import.meta !== "undefined" &&
      typeof import.meta.resolve === "function"
    ) {
      const resolved = import.meta.resolve(packageSpec);
      let resolvedPath: string;
      try {
        const url = new URL(resolved);
        resolvedPath = url.pathname;
      } catch {
        resolvedPath = resolved;
      }
      if (resolvedPath.endsWith(".mjs")) {
        return "esm";
      }
      if (resolvedPath.endsWith(".js") && !resolvedPath.endsWith(".mjs")) {
        return "cjs";
      }
    }
  } catch {
    // import.meta.resolve might not be available
  }

  try {
    if (typeof require !== "undefined" && require.resolve) {
      const resolved = require.resolve(packageSpec);
      if (resolved.endsWith(".js") && !resolved.endsWith(".mjs")) {
        return "cjs";
      }
      if (resolved.endsWith(".mjs")) {
        return "esm";
      }
    }
  } catch {
    // require.resolve might not be available
  }

  return "unknown";
}
