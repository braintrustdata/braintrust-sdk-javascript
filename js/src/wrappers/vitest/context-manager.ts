import iso, { type IsoAsyncLocalStorage } from "../../isomorph";
import type { Dataset, Experiment } from "../../logger";

/**
 * VitestExperimentContext - State for a single describe block
 *
 * Contains the information to log tests to the correct experiment:
 * - experiment: The Experiment instance tests should log to
 * - dataset: Optional dataset for input/expected/metadata tracking
 * - datasetExamples: Maps test names to dataset example IDs
 * - parent: Link to parent describe's context (for nested hierarchy)
 * - flushPromise/flushResolved: Coordination for experiment flushing
 */
export interface VitestExperimentContext {
  dataset: Dataset<false> | undefined;
  experiment: Experiment;
  datasetExamples: Map<string, string>;
  parent?: VitestExperimentContext; // Link to parent describe
  flushPromise?: Promise<void>;
  flushResolved: boolean;
  passed: number;
  failed: number;
}

/**
 * VitestContextManager - Manages experiment context for Vitest test suites
 *
 * Contexts support parent linking for nested describes:
 * ```typescript
 * bt.describe("Parent", () => {
 *   // Context 1: parent = undefined
 *
 *   bt.describe("Child", () => {
 *     // Context 2: parent = Context 1
 *   });
 *
 *   // Back to Context 1 (context restored!)
 * });
 * ```
 *
 */
class VitestContextManager {
  /**
   * AsyncLocalStorage for experiment context isolation.
   * Each async execution flow (test, concurrent test, worker thread) gets its own context.
   */
  private contextStorage: IsoAsyncLocalStorage<VitestExperimentContext>;

  constructor() {
    this.contextStorage = iso.newAsyncLocalStorage();
  }

  getCurrentContext(): VitestExperimentContext | undefined {
    return this.contextStorage.getStore();
  }

  setContext(context: VitestExperimentContext): void {
    // TODO(luca): Replace ALS.enterWith() with ALS.run()
    // eslint-disable-next-line no-restricted-syntax -- Existing ALS.enterWith() usage tracked by the TODO above.
    this.contextStorage.enterWith(context);
  }

  runInContext<R>(context: VitestExperimentContext, callback: () => R): R {
    return this.contextStorage.run(context, callback);
  }

  createChildContext(
    dataset: Dataset<false> | undefined,
    experiment: Experiment,
  ): VitestExperimentContext {
    const parent = this.getCurrentContext();
    return {
      dataset,
      experiment,
      datasetExamples: new Map(),
      parent,
      flushResolved: true,
      passed: 0,
      failed: 0,
    };
  }
}

let _contextManager: VitestContextManager | undefined;

export function getVitestContextManager(): VitestContextManager {
  if (!_contextManager) {
    _contextManager = new VitestContextManager();
  }
  return _contextManager;
}

export function _resetContextManager(): void {
  _contextManager = undefined;
}
