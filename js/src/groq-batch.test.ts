import { afterEach, beforeAll, beforeEach, expect, it } from "vite-plus/test";
import { completeGroqBatchTrace, startGroqBatchTrace } from "./groq-batch";
import { initLogger, startSpan, withCurrent } from "./logger/core";
import { _exportsForTestingOnly as testing } from "./logger/testing";
import { configureNode } from "./node/config";

configureNode();
const batch = {
  id: "batch-1",
  input_file_id: "file-1",
  endpoint: "/v1/chat/completions",
  status: "validating",
  created_at: 10,
};
const requests = ["one", "two"].map((custom_id) => ({
  custom_id,
  url: batch.endpoint,
  method: "POST",
  body: {
    model: "groq-model",
    messages: [{ role: "user", content: "secret prompt" }],
  },
}));
type TestRow = {
  id: string;
  span_id: string;
  span_attributes?: { name: string };
  span_parents?: string[];
  metrics?: Record<string, number>;
  metadata?: { custom_id?: string };
  error?: string;
};

let background: ReturnType<typeof testing.useTestBackgroundLogger>;
beforeAll(async () => {
  await testing.simulateLoginForTests();
});
beforeEach(() => {
  background = testing.useTestBackgroundLogger();
  initLogger({ projectName: "groq-batch", projectId: "project-id" });
});
afterEach(() => {
  testing.clearTestBackgroundLogger();
});

it("resumes under the submitting parent and matches unordered files across retries", async () => {
  const parent = startSpan({ name: "producer" });
  const context = await withCurrent(parent, () =>
    startGroqBatchTrace({
      batch,
      inputFileContent: new Response(
        requests.map((row) => JSON.stringify(row)).join("\r\n"),
      ),
    }),
  );
  expect(context).toBeTruthy();
  expect(context).not.toContain("secret prompt");
  const initial = (await background.drain()) as TestRow[];
  const task = initial.find(
    (row) => row.span_attributes?.name === "groq.batch",
  )!;
  expect(task.span_parents).toEqual([parent.spanId]);
  const children = initial.filter(
    (row) => row.span_attributes?.name === "groq.chat.completions.create",
  );
  expect(children).toHaveLength(2);
  for (const child of children) {
    expect(child.span_parents).toEqual([task.span_id]);
    expect(child.metrics).toMatchObject({ start: 10 });
    expect(child.metrics?.end).toBeUndefined();
  }
  const terminal = { ...batch, status: "completed", completed_at: 20 };
  const result = {
    custom_id: "two",
    response: {
      status_code: 200,
      body: {
        choices: [{ message: { content: "hi" } }],
        usage: { total_tokens: 7 },
      },
    },
  };
  await completeGroqBatchTrace({
    context: context!,
    batch,
    outputFileContent: [result],
  });
  await completeGroqBatchTrace({
    context: context!,
    batch: { ...terminal, id: "other" },
  });
  expect(await background.drain()).toHaveLength(0);
  await completeGroqBatchTrace({
    context: context!,
    batch: terminal,
    outputFileContent: [result],
  });
  const partial = await background.drain();
  expect(partial).toHaveLength(1);
  expect(partial[0].id).toBe(
    children.find((row) => row.metadata?.custom_id === "two")!.id,
  );
  for (let retry = 0; retry < 2; retry++) {
    await withCurrent(startSpan({ name: "consumer" }), () =>
      completeGroqBatchTrace({
        batch: terminal,
        context: context!,
        outputFileContent: [result],
        errorFileContent: JSON.stringify({
          custom_id: "one",
          error: { message: "bad request" },
        }),
      }),
    );
    const rows = (await background.drain()) as TestRow[];
    expect(rows.find((row) => row.id === partial[0].id)).toMatchObject({
      output: result.response.body.choices,
      metrics: { end: 20, tokens: 7 },
    });
    expect(rows.find((row) => row.id === task.id)).toMatchObject({
      metrics: { end: 20 },
      metadata: { status: "completed" },
    });
    expect(
      rows.find(
        (row) =>
          row.id ===
          children.find((child) => child.metadata?.custom_id === "one")!.id,
      )?.error,
    ).toContain("bad request");
  }
});

it.each(["transcriptions", "translations"])(
  "captures audio %s at collection and ends unresolved requests on cancellation",
  async (operation) => {
    const endpoint = "/v1/audio/" + operation;
    await completeGroqBatchTrace({
      batch: { ...batch, endpoint, status: "cancelled", cancelled_at: 15 },
      inputFileContent: requests.map((row) => ({
        ...row,
        url: endpoint,
        body: {
          model: "whisper-large-v3",
          url: "https://example.com/audio.wav",
        },
      })),
      outputFileContent: [
        {
          custom_id: "one",
          response: {
            status_code: 200,
            body: { text: "hello", language: "en" },
          },
        },
      ],
    });
    const rows = (await background.drain()) as TestRow[];
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.metadata?.custom_id === "one")).toMatchObject(
      {
        span_attributes: { name: "groq.audio." + operation + ".create" },
        output: {
          content: [{ type: "text", text: "hello" }],
          annotations: { language: "en" },
        },
      },
    );
    expect(rows.filter((row) => row.error)).toHaveLength(2);
    for (const row of rows) expect(row.metrics?.end).toBe(15);
  },
);
