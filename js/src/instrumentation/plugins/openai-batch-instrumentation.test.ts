import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  _exportsForTestingOnly,
  initLogger,
  startSpan,
  withCurrent,
} from "../../logger";
import { configureNode } from "../../node/config";
import {
  completeOpenAIBatchTrace,
  openaiBatchesRetrieveTraced,
  openaiFilesCreateTraced,
} from "../../openai-batch";
import type {
  OpenAIAPIPromise,
  OpenAIBatchLike,
  OpenAIEnhancedResponse,
} from "../../openai-batch-types";
import { SpanComponentsV4 } from "../../../util/span_identifier_v4";
import { OpenAIPlugin } from "./openai-plugin";

try {
  configureNode();
} catch {
  // Best-effort initialization for test environments.
}

const chatInput = [
  {
    custom_id: "ok",
    method: "POST",
    url: "/v1/chat/completions",
    body: {
      model: "gpt-test",
      messages: [{ role: "user", content: "hi" }],
    },
  },
  {
    custom_id: "bad",
    method: "POST",
    url: "/v1/chat/completions",
    body: {
      model: "gpt-test",
      messages: [{ role: "user", content: "fail" }],
    },
  },
];

function jsonl(records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n");
}

function apiPromise<T>(data: T): OpenAIAPIPromise<T> {
  return asyncAPIPromise(Promise.resolve(data));
}

function asyncAPIPromise<T>(dataPromise: Promise<T>): OpenAIAPIPromise<T> {
  const promise = dataPromise as OpenAIAPIPromise<T>;
  let enhancedResponse: Promise<OpenAIEnhancedResponse<T>> | undefined;
  promise.withResponse = () => {
    enhancedResponse ??= dataPromise.then((data) => ({
      data,
      response: new Response(JSON.stringify(data), {
        headers: { "content-type": "application/json" },
      }),
      request_id: "request-id",
    }));
    return enhancedResponse;
  };
  promise.asResponse = async () => (await promise.withResponse()).response;
  return promise;
}

async function uploadedText(upload: unknown): Promise<string> {
  if (upload instanceof Blob) {
    return await upload.text();
  }
  const chunks: Uint8Array[] = [];
  for await (const chunk of upload as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

describe("OpenAI Batch instrumentation", () => {
  let backgroundLogger: ReturnType<
    typeof _exportsForTestingOnly.useTestBackgroundLogger
  >;
  let plugin: OpenAIPlugin;

  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
  });

  beforeEach(() => {
    backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({
      projectName: "openai-batch-instrumentation.test.ts",
      projectId: "test-project-id",
    });
    plugin = new OpenAIPlugin();
    plugin.enable();
  });

  afterEach(() => {
    plugin.disable();
    _exportsForTestingOnly.clearTestBackgroundLogger();
  });

  it("tees upload streams and starts spans keyed by file ID and custom_id", async () => {
    const source = jsonl(chatInput);
    let received = "";
    const files = {
      marker: "files-resource",
      create(
        this: { marker: string },
        params: { file: unknown; purpose: string },
      ) {
        expect(this.marker).toBe("files-resource");
        return asyncAPIPromise(
          Promise.resolve({ id: "file_stream", purpose: params.purpose }).then(
            async (file) => {
              received = await uploadedText(params.file);
              return file;
            },
          ),
        );
      },
    };
    const encoder = new TextEncoder();
    const upload = {
      path: "/tmp/batch.jsonl",
      async *[Symbol.asyncIterator]() {
        yield encoder.encode(source.slice(0, 19));
        yield encoder.encode(source.slice(19));
      },
    };

    const file = await openaiFilesCreateTraced(files)({
      file: upload,
      purpose: "batch",
    });

    expect(file.id).toBe("file_stream");
    expect(received).toBe(source);
    const rows = (await backgroundLogger.drain()) as Array<Record<string, any>>;
    expect(rows).toHaveLength(3);
    expect(
      rows.find((row) => row.span_attributes?.name === "openai.batch"),
    ).toMatchObject({
      metadata: {
        endpoint: "/v1/chat/completions",
        input_file_id: "file_stream",
        provider: "openai",
      },
      span_attributes: { type: "task" },
    });
    const children = rows.filter(
      (row) => row.span_attributes?.name === "Chat Completion",
    );
    expect(children).toHaveLength(2);
    expect(children.map((row) => row.metadata.custom_id).sort()).toEqual([
      "bad",
      "ok",
    ]);
    expect(children.map((row) => row.input[0].content).sort()).toEqual([
      "fail",
      "hi",
    ]);
    expect(children.every((row) => row.metrics.end === undefined)).toBe(true);
  });

  it("preserves OpenAI promise helpers and passes non-batch files through", async () => {
    let calls = 0;
    const files = {
      create(
        params: { file: Blob; purpose: string },
        options?: { timeout: number },
      ) {
        calls++;
        expect(options).toEqual({ timeout: 10 });
        return apiPromise({ id: `file_${params.purpose}` });
      },
    };
    const create = openaiFilesCreateTraced(files);

    const traced = create(
      { file: new Blob([jsonl([chatInput[0]])]), purpose: "batch" },
      { timeout: 10 },
    );
    expect(typeof traced.withResponse).toBe("function");
    expect(typeof traced.asResponse).toBe("function");
    await expect(traced.withResponse()).resolves.toMatchObject({
      data: { id: "file_batch" },
      request_id: "request-id",
    });

    const ordinary = create(
      { file: new Blob(["ordinary"]), purpose: "assistants" },
      { timeout: 10 },
    );
    await expect(ordinary).resolves.toEqual({ id: "file_assistants" });
    expect(calls).toBe(2);
    expect(await backgroundLogger.drain()).toHaveLength(2);
  });

  it("uses stable span IDs when the same file is observed again", async () => {
    let uploadCount = 0;
    const files = {
      create() {
        uploadCount++;
        return apiPromise({ id: "file_stable" });
      },
    };
    const create = openaiFilesCreateTraced(files);
    const params = {
      file: new Blob([jsonl([chatInput[0]])]),
      purpose: "batch",
    };

    await create(params);
    const first = (await backgroundLogger.drain()) as Array<
      Record<string, any>
    >;
    await create(params);
    const second = (await backgroundLogger.drain()) as Array<
      Record<string, any>
    >;

    expect(uploadCount).toBe(2);
    expect(second.map((row) => row.id).sort()).toEqual(
      first.map((row) => row.id).sort(),
    );
  });

  it("retrieves batches through the resource and corrects lifecycle timestamps", async () => {
    const parent = startSpan({ name: "parent" });
    await withCurrent(parent, async () => {
      await openaiFilesCreateTraced({
        create() {
          return apiPromise({ id: "file_timestamps" });
        },
      })({ file: new Blob([jsonl(chatInput)]), purpose: "batch" });
    });
    await backgroundLogger.drain();
    const batch: OpenAIBatchLike = {
      id: "batch_timestamps",
      endpoint: "/v1/chat/completions",
      input_file_id: "file_timestamps",
      status: "completed",
      created_at: 100,
      in_progress_at: 110,
      completed_at: 200,
    };
    const batches = {
      marker: "batches-resource",
      retrieve(this: { marker: string }, batchId: string) {
        expect(this.marker).toBe("batches-resource");
        expect(batchId).toBe("batch_timestamps");
        return apiPromise(batch);
      },
    };

    const result = await openaiBatchesRetrieveTraced(batches)(batch.id);
    const parentComponents = SpanComponentsV4.fromStr(await parent.export());
    parent.end();

    expect(result).toBe(batch);
    const rows = (await backgroundLogger.drain()) as Array<Record<string, any>>;
    const task = rows.find(
      (row) => row.span_attributes?.name === "openai.batch",
    );
    const children = rows.filter(
      (row) => row.span_attributes?.name === "Chat Completion",
    );
    expect(task?.metrics).toMatchObject({ start: 100, end: 200 });
    expect(task?.span_parents).toEqual([parentComponents.data.span_id]);
    expect(task?.root_span_id).toBe(parentComponents.data.root_span_id);
    expect(children).toHaveLength(2);
    expect(
      children.every(
        (row) => row.metrics.start === 110 && row.metrics.end === 200,
      ),
    ).toBe(true);
  });

  it("completes result spans by custom_id and consumes supplied responses", async () => {
    await openaiFilesCreateTraced({
      create() {
        return apiPromise({ id: "file_results" });
      },
    })({ file: new Blob([jsonl(chatInput)]), purpose: "batch" });
    const pendingRows = (await backgroundLogger.drain()) as Array<
      Record<string, any>
    >;
    const pendingIds = pendingRows.map((row) => row.id).sort();
    await openaiBatchesRetrieveTraced({
      retrieve() {
        return apiPromise({
          id: "batch_results",
          endpoint: "/v1/chat/completions",
          input_file_id: "file_results",
          status: "completed",
          created_at: 100,
          in_progress_at: 110,
          completed_at: 200,
        });
      },
    })("batch_results");
    await backgroundLogger.drain();
    const inputFileContent = new Response(jsonl(chatInput));
    const outputFileContent = new Response(
      jsonl([
        {
          custom_id: "ok",
          response: {
            status_code: 200,
            body: {
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: "hello" },
                },
              ],
              model: "gpt-result",
              usage: {
                prompt_tokens: 2,
                completion_tokens: 3,
                total_tokens: 5,
              },
            },
          },
        },
      ]),
    );
    const errorFileContent = new Response(
      jsonl([
        {
          custom_id: "bad",
          error: { code: "server_error", message: "failed" },
        },
      ]),
    );

    await completeOpenAIBatchTrace({
      inputFileId: "file_results",
      inputFileContent,
      outputFileContent,
      errorFileContent,
    });

    expect(inputFileContent.bodyUsed).toBe(true);
    expect(outputFileContent.bodyUsed).toBe(true);
    expect(errorFileContent.bodyUsed).toBe(true);
    const rows = (await backgroundLogger.drain()) as Array<Record<string, any>>;
    expect(rows.map((row) => row.id).sort()).toEqual(pendingIds);
    expect(rows.find((row) => row.output !== undefined)).toMatchObject({
      metadata: { model: "gpt-result", provider: "openai" },
      metrics: {
        completion_tokens: 3,
        end: 200,
        prompt_tokens: 2,
        tokens: 5,
      },
      output: [{ index: 0, message: { role: "assistant", content: "hello" } }],
    });
    expect(rows.find((row) => row.error !== undefined)?.error).toContain(
      "failed",
    );
  });

  it("does not interfere with uploads when the JSONL is invalid", async () => {
    const content = "not jsonl";
    let received = "";
    const result = await openaiFilesCreateTraced({
      create(params: { file: Blob; purpose: string }) {
        return asyncAPIPromise(
          Promise.resolve({ id: "file_invalid" }).then(async (file) => {
            received = await params.file.text();
            return file;
          }),
        );
      },
    })({ file: new Blob([content]), purpose: "batch" });

    expect(result).toEqual({ id: "file_invalid" });
    expect(received).toBe(content);
    expect(await backgroundLogger.drain()).toEqual([]);
  });
});
