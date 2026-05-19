import { afterEach, describe, expect, it } from "vitest";
import { GenkitPlugin } from "./genkit-plugin";
import { genkitChannels } from "./genkit-channels";

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

  afterEach(() => {
    plugin.disable();
  });

  it("does not consume generateStream chunks before user code reads them", async () => {
    plugin.enable();
    const stream = singleQueueStream([{ text: "hello" }, { text: " world" }]);

    const result = genkitChannels.generateStream.traceSync(
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
      { arguments: [{ prompt: "Say hello world." }] } as Parameters<
        typeof genkitChannels.generateStream.traceSync
      >[1],
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

    const result = genkitChannels.actionStream.traceSync(
      () => ({
        output: Promise.resolve({ done: true }),
        stream,
      }),
      {
        arguments: [{ input: true }],
        self: action,
      } as Parameters<typeof genkitChannels.actionStream.traceSync>[1],
    );

    await drainMicrotasks();

    await expect(collectAsync(result.stream)).resolves.toEqual([
      "first",
      "second",
    ]);
  });
});
