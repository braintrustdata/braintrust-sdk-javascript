import { vi } from "vite-plus/test";
import { configureNode } from "../../node/config";
import { _exportsForTestingOnly } from "../../logger/testing";
import { type TestBackgroundLogger } from "../../logger/core";
import * as logger from "../../logger/experiments";
import type { MinimalTestContext } from "./types";

/**
 * Sets up the test environment for node-test wrapper tests.
 * Must be called at module level (top-level await).
 *
 * Returns the background logger for span verification.
 */
export async function setupNodeTestEnv(): Promise<TestBackgroundLogger> {
  configureNode();
  _exportsForTestingOnly.setInitialTestState();
  await _exportsForTestingOnly.simulateLoginForTests();
  const bgLogger = _exportsForTestingOnly.useTestBackgroundLogger();

  vi.spyOn(logger, "init").mockImplementation((options) => {
    return _exportsForTestingOnly.initTestExperiment(
      options.experiment || "test-experiment",
      options.project ?? options.projectId ?? "test-project",
    );
  });

  return bgLogger;
}

export function teardownNodeTestEnv(): void {
  _exportsForTestingOnly.clearTestBackgroundLogger();
  _exportsForTestingOnly.simulateLogoutForTests();
}

export function mockTestContext(name: string): MinimalTestContext {
  return { name };
}
