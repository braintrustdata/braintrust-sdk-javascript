/**
 * Vitest integration. Available as `seinfeld/vitest` sub-path export.
 *
 * Wraps `createCassette` with `beforeEach`/`afterEach` hooks so each test
 * automatically gets a fresh cassette named after the test, started before
 * the test body runs and stopped (with persistence in record mode) after.
 *
 * Usage:
 *
 * ```ts
 * import { setupCassettes } from 'seinfeld/vitest';
 * import { createJsonFileStore } from 'seinfeld';
 *
 * setupCassettes({
 *   store: createJsonFileStore({ rootDir: 'test/__cassettes__' }),
 *   filters: 'default',
 *   mode: process.env.SEINFELD_MODE === 'record' ? 'record' : 'replay',
 * });
 *
 * test('chat completes', async () => {
 *   const res = await fetch('https://api.openai.com/v1/chat/completions', { ... });
 *   expect(res.ok).toBe(true);
 * });
 * ```
 */

import { basename } from "node:path";
import { afterEach, beforeEach, expect } from "vitest";
import {
  createCassette,
  type Cassette,
  type CassetteOptions,
} from "./recorder";

export interface VitestCassetteOptions extends Omit<CassetteOptions, "name"> {
  /**
   * Derive the cassette name for the current test. Defaults to
   * `<test-file-basename>/<slugified test name>`. The result is passed to the
   * store as a logical name (e.g. for `createJsonFileStore`, becomes a file
   * path under the configured `rootDir`).
   */
  nameFor?: (ctx: VitestNameContext) => string;
}

/** Information available when deriving a cassette name. */
export interface VitestNameContext {
  /** Absolute path to the test file. */
  testPath: string;
  /**
   * Full test name including ancestor `describe` blocks, e.g.
   * `"chat completes > with history"`.
   */
  testName: string;
}

/** Handle returned by `setupCassettes`. */
export interface VitestCassetteHandle {
  /**
   * The cassette active for the currently-running test. Throws if called
   * outside a Vitest test (e.g., from `describe` block setup).
   */
  current(): Cassette;
}

/**
 * Register Vitest hooks that create, start, and stop a cassette around each
 * test. Returns a handle for accessing the active cassette mid-test if you
 * need to configure it dynamically.
 */
export function setupCassettes(
  options: VitestCassetteOptions = {},
): VitestCassetteHandle {
  let active: Cassette | null = null;

  beforeEach(async () => {
    if (isCurrentTestConcurrent()) {
      throw new Error(
        "seinfeld/vitest: setupCassettes() is not safe with test.concurrent. " +
          "The shared MSW server and per-test cassette state are process-global. " +
          "Run tests sequentially (remove .concurrent) or isolate them in separate workers.",
      );
    }
    const ctx = readContext();
    const name = options.nameFor ? options.nameFor(ctx) : defaultName(ctx);
    const { nameFor: _nameFor, ...rest } = options;
    active = createCassette({ ...rest, name });
    await active.start();
  });

  afterEach(async () => {
    const c = active;
    active = null;
    if (c) await c.stop();
  });

  return {
    current() {
      if (!active) {
        throw new Error(
          "seinfeld/vitest: no active cassette. current() must be called from within a test body.",
        );
      }
      return active;
    },
  };
}

function readContext(): VitestNameContext {
  const state = expect.getState();
  return {
    testPath: state.testPath ?? "unknown",
    testName: state.currentTestName ?? "unknown",
  };
}

function isCurrentTestConcurrent(): boolean {
  // Vitest attaches the current task to the expect state as an internal field.
  const state = expect.getState() as unknown as {
    task?: { concurrent?: boolean };
  };
  return state.task?.concurrent === true;
}

function defaultName(ctx: VitestNameContext): string {
  const fileSlug = basename(ctx.testPath).replace(
    /\.(test|spec)\.[jt]sx?$/,
    "",
  );
  return `${slugify(fileSlug)}/${slugify(ctx.testName)}`;
}

/**
 * Slugify a string into something safe for filesystem paths. Preserves
 * forward slashes (so describe-block hierarchies map to subdirectories).
 */
function slugify(str: string): string {
  return str
    .trim()
    .replace(/\s*>\s*/g, "/")
    .replace(/[^a-zA-Z0-9_/-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/(^-|-$)/g, "")
    .replace(/\/+/g, "/");
}
