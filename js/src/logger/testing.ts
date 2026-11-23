import {
  extractAttachments,
  deepCopyEvent,
  isGeneratorFunction,
  isAsyncGeneratorFunction,
  validateTags,
} from "./core";
import { resetDebugLoggerForTests } from "../debug-logger";
/// <reference lib="dom" />
import iso from "#braintrust-platform";
import { LazyValue } from "../util";
import {
  TestBackgroundLogger,
  type BraintrustState,
  _internalGetGlobalState,
  ProjectExperimentMetadata,
  _internalSetInitialState,
  login,
  RESET_CONTEXT_MANAGER_STATE,
} from "./core";
import { Experiment } from "./experiments";

// Return a TestBackgroundLogger that will intercept logs before they are sent to the server.
// Used for testing only.
function useTestBackgroundLogger(): TestBackgroundLogger {
  const state = _internalGetGlobalState();
  if (!state) {
    throw new Error("global state not set yet");
  }

  const logger = new TestBackgroundLogger();
  state.setOverrideBgLogger(logger);
  return logger;
}

function clearTestBackgroundLogger(): void {
  _internalGetGlobalState()?.setOverrideBgLogger(null);
}

// Initialize a test Experiment without making network calls by injecting fake metadata.
// Useful for unit tests that need an Experiment instance.
function initTestExperiment(
  experimentName: string,
  projectName?: string,
  experimentFullInfo: Record<string, unknown> = {},
): Experiment {
  setInitialTestState();
  const state = _internalGetGlobalState();
  const project = projectName ?? experimentName;

  const lazyMetadata: LazyValue<ProjectExperimentMetadata> = new LazyValue(
    async () => ({
      project: { id: project, name: project, fullInfo: {} },
      experiment: {
        id: experimentName,
        name: experimentName,
        fullInfo: experimentFullInfo,
      },
    }),
  );

  return new Experiment(state, lazyMetadata);
}

/**
 * Allows accessing helper functions for testing.
 * @internal
 */

// it's used to circumvent login for testing, but won't actually work
// on the server side.
const TEST_API_KEY = "___TEST_API_KEY__THIS_IS_NOT_REAL___";

function setInitialTestState(): void {
  // a way of setting initial state for tests without any log messages
  if (!_internalGetGlobalState()) {
    _internalSetInitialState();
  }
}

// This is a helper function to simulate a login for testing.
async function simulateLoginForTests(): Promise<BraintrustState> {
  return await login({
    apiKey: TEST_API_KEY,
    appUrl: "https://braintrust.dev",
  });
}

// This is a helper function to simulate a logout for testing.
function simulateLogoutForTests(): BraintrustState {
  const state = _internalGetGlobalState();
  state.resetLoginInfo();
  state.resetIdGenState();
  state[RESET_CONTEXT_MANAGER_STATE]();
  state.appUrl = "https://www.braintrust.dev";
  return state;
}

// Helper function to reset ID generator state for testing
function resetIdGenStateForTests(): void {
  const state = _internalGetGlobalState();
  if (state) {
    state.resetIdGenState();
  }
}

export const _exportsForTestingOnly: {
  extractAttachments: typeof extractAttachments;
  deepCopyEvent: typeof deepCopyEvent;
  useTestBackgroundLogger: typeof useTestBackgroundLogger;
  clearTestBackgroundLogger: typeof clearTestBackgroundLogger;
  resetDebugLoggerForTests: typeof resetDebugLoggerForTests;
  simulateLoginForTests: typeof simulateLoginForTests;
  simulateLogoutForTests: typeof simulateLogoutForTests;
  setInitialTestState: typeof setInitialTestState;
  initTestExperiment: typeof initTestExperiment;
  isGeneratorFunction: typeof isGeneratorFunction;
  isAsyncGeneratorFunction: typeof isAsyncGeneratorFunction;
  resetIdGenStateForTests: typeof resetIdGenStateForTests;
  validateTags: typeof validateTags;
  isomorph: any;
} = {
  extractAttachments,
  deepCopyEvent,
  useTestBackgroundLogger,
  clearTestBackgroundLogger,
  resetDebugLoggerForTests,
  simulateLoginForTests,
  simulateLogoutForTests,
  setInitialTestState,
  initTestExperiment,
  isGeneratorFunction,
  isAsyncGeneratorFunction,
  resetIdGenStateForTests,
  validateTags,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  isomorph: iso as any, // Expose isomorph for build type detection
};
