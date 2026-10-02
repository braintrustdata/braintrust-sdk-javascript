import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { _exportsForTestingOnly, initLogger } from "../../logger";
import { genkitChannels } from "./genkit-channels";
import { GenkitPlugin } from "./genkit-plugin";

function singleQueueStream<T>(
  chunks: T[],
): AsyncIterable<T> & AsyncIterator<T> {
  let index = 0;
  return {
    async next() {
      await Promise.resolve();
      if (index >= chunks.length) {
        return { done: true, value: undefined };
      }
      return { done: false, value: chunks[index++] };
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

async function drainMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index++) {
    await Promise.resolve();
  }
}

async function collectAsync<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const chunks: T[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

describe("GenkitPlugin stream patching", () => {
  const plugin = new GenkitPlugin();

  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
  });

  beforeEach(() => {
    _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({
      projectName: "genkit-plugin.test.ts",
      projectId: "test-project-id",
    });
  });

  afterEach(() => {
    plugin.disable();
    _exportsForTestingOnly.clearTestBackgroundLogger();
  });

  it("does not consume generateStream chunks before user code reads them", async () => {
    plugin.enable();
    const stream = singleQueueStream([{ text: "hello" }, { text: " world" }]);

    const result = genkitChannels.generateStream.invoke(
      () => ({
        response: Promise.resolve({
          text: "hello world",
          usage: {
            inputTokens: 1,
            outputTokens: 2,
            totalTokens: 3,
          },
        }),
        stream,
      }),
      undefined,
      [{ prompt: "Say hello world." }],
      {},
    );

    await drainMicrotasks();

    await expect(collectAsync(result.stream)).resolves.toEqual([
      { text: "hello" },
      { text: " world" },
    ]);
  });

  it("does not consume action.stream chunks before user code reads them", async () => {
    plugin.enable();
    const stream = singleQueueStream(["first", "second"]);
    const action = Object.assign(() => Promise.resolve(), {
      __action: {
        actionType: "tool",
        name: "streamTool",
      },
    });

    const result = genkitChannels.actionStream.invoke(
      () => ({
        output: Promise.resolve({ done: true }),
        stream,
      }),
      action,
      [{ input: true }],
      {},
    );

    await drainMicrotasks();

    await expect(collectAsync(result.stream)).resolves.toEqual([
      "first",
      "second",
    ]);
  });
});
