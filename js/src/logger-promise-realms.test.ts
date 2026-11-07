import { runInNewContext } from "node:vm";
import { expect, test, vi } from "vitest";
import { _exportsForTestingOnly, initLogger } from "./logger";
import { configureNode } from "./node/config";

configureNode();

test("Logger.traced keeps the span open until a foreign promise settles", async () => {
  await _exportsForTestingOnly.simulateLoginForTests();
  const memoryLogger = _exportsForTestingOnly.useTestBackgroundLogger();

  try {
    let resolve!: (value: number) => void;
    const promise: Promise<number> = runInNewContext(
      "new Promise(resolve => capture(resolve))",
      {
        capture: (resolvePromise: (value: number) => void) => {
          resolve = resolvePromise;
        },
      },
    );
    const logger = initLogger({
      projectName: "test",
      projectId: "test-project-id",
    });
    let endCalls = () => 0;
    const result = logger.traced((span) => {
      const end = vi.spyOn(span, "end");
      endCalls = () => end.mock.calls.length;
      return promise;
    });

    expect(endCalls()).toBe(0);
    resolve(42);
    await expect(result).resolves.toBe(42);
    expect(endCalls()).toBe(1);
    await memoryLogger.flush();
  } finally {
    _exportsForTestingOnly.clearTestBackgroundLogger();
    _exportsForTestingOnly.simulateLogoutForTests();
  }
});
