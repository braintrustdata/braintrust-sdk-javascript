import { BraintrustStream } from "braintrust";
import { ReadableStream, WritableStream } from "stream/web";
import { expect, test } from "vitest";
import { BraintrustAdapter } from ".";

type BraintrustStreamChunk =
  ReturnType<BraintrustStream["toReadableStream"]> extends ReadableStream<
    infer Chunk
  >
    ? Chunk
    : never;

test("text callbacks", async () => {
  const textStream = new ReadableStream<BraintrustStreamChunk>({
    start(controller) {
      controller.enqueue({ type: "text_delta", data: "Hello, " });
      controller.enqueue({ type: "text_delta", data: "world!" });
      controller.close();
    },
  });

  const { started, completion, final, tokens, text } =
    await streamWithCallbacks(textStream);

  expect(started).toBe(true);
  expect(completion).toBe("Hello, world!");
  expect(final).toBe("Hello, world!");
  expect(tokens).toEqual(["Hello, ", "world!"]);
  expect(text).toEqual(["Hello, ", "world!"]);
});

test("json callbacks", async () => {
  const toolStream = new ReadableStream<BraintrustStreamChunk>({
    start(controller) {
      controller.enqueue({ type: "json_delta", data: `{"a":` });
      controller.enqueue({ type: "json_delta", data: ` 1}` });
      controller.close();
    },
  });

  const { started, completion, final, tokens, text } =
    await streamWithCallbacks(toolStream);

  expect(started).toBe(true);
  expect(completion).toBe(null);
  expect(final && JSON.parse(final)).toEqual({ a: 1 });
  expect(tokens).toEqual([]);
  expect(text).toEqual([]);
});

async function streamWithCallbacks(
  stream: ReadableStream<BraintrustStreamChunk>,
) {
  let started = false;
  let completion: string | null = null;
  let final: string | null = null;
  let tokens: string[] = [];
  let text: string[] = [];

  const vercelStream = BraintrustAdapter.toAIStream(stream, {
    onStart: () => {
      started = true;
    },
    onCompletion: (c) => {
      completion = c;
    },
    onFinal: (f) => {
      final = f;
    },
    onToken: (t) => {
      tokens.push(t);
    },
    onText: (t) => {
      text.push(t);
    },
  });

  await vercelStream.pipeTo(
    new WritableStream({
      write(chunk) {
        console.log(new TextDecoder().decode(chunk));
      },
    }),
  );

  return { started, completion, final, tokens, text };
}
