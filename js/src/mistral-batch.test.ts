import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  completeMistralBatchTrace,
  mistralBatchJobsCreateTraced,
  mistralFilesUploadTraced,
} from "./mistral-batch";
import {
  _exportsForTestingOnly,
  _internalGetGlobalState,
  initLogger,
} from "./logger";
import { configureNode } from "./node/config";

try {
  configureNode();
} catch {
  // Best-effort initialization for test environments.
}

const requests = [
  {
    customId: "one",
    body: { messages: [{ role: "user", content: "first" }] },
  },
  {
    customId: "two",
    body: { messages: [{ role: "user", content: "second" }] },
  },
];

describe("Mistral Batch API", () => {
  let backgroundLogger: ReturnType<
    typeof _exportsForTestingOnly.useTestBackgroundLogger
  >;

  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
    _internalGetGlobalState()._internalSetTraceContextSigningSecret(
      "mistral-batch-api-test-secret",
    );
  });

  beforeEach(() => {
    backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({
      projectName: "mistral-batch.test.ts",
      projectId: "test-project-id",
    });
  });

  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
  });

  it("wraps inline jobs.create without changing its call shape", async () => {
    let receivedParams: unknown;
    const jobs = {
      marker: "jobs-resource",
      async create(
        this: { marker: string },
        params: {
          requests: typeof requests;
          endpoint: "/v1/chat/completions";
          model: string;
          metadata?: Record<string, string>;
        },
        options?: { timeout: number },
      ) {
        expect(this.marker).toBe("jobs-resource");
        expect(options).toEqual({ timeout: 10 });
        receivedParams = params;
        return {
          id: "batch-inline",
          endpoint: params.endpoint,
          model: params.model,
          metadata: params.metadata,
          status: "QUEUED",
          totalRequests: params.requests.length,
        };
      },
    };

    const batch = await mistralBatchJobsCreateTraced(jobs)(
      {
        requests,
        endpoint: "/v1/chat/completions",
        model: "mistral-small-latest",
      },
      { timeout: 10 },
    );

    expect(batch.id).toBe("batch-inline");
    expect(receivedParams).toMatchObject({
      requests,
      metadata: { "braintrust.batch_context": expect.any(String) },
    });
    expect(await backgroundLogger.drain()).toHaveLength(3);
  });

  it("connects traced file uploads to file-backed jobs.create", async () => {
    const source = requests
      .map(({ customId, body }) =>
        JSON.stringify({ custom_id: customId, body }),
      )
      .join("\n");
    let uploaded = "";
    const inputFile = await mistralFilesUploadTraced({
      async upload(params: {
        file: { fileName: string; content: ReadableStream<Uint8Array> };
        purpose: string;
      }) {
        uploaded = await new Response(params.file.content).text();
        return { id: "file-batch" };
      },
    })({
      file: {
        fileName: "batch.jsonl",
        content: new Blob([source]).stream(),
      },
      purpose: "batch",
    });

    let receivedParams: unknown;
    await mistralBatchJobsCreateTraced({
      async create(params: {
        inputFiles: string[];
        endpoint: "/v1/chat/completions";
        model: string;
        metadata?: Record<string, string>;
      }) {
        receivedParams = params;
        return {
          id: "batch-file",
          endpoint: params.endpoint,
          model: params.model,
          metadata: params.metadata,
          inputFiles: params.inputFiles,
          status: "QUEUED",
          totalRequests: 2,
        };
      },
    })({
      inputFiles: [inputFile.id],
      endpoint: "/v1/chat/completions",
      model: "mistral-small-latest",
    });

    expect(uploaded).toBe(source);
    expect(receivedParams).toMatchObject({
      inputFiles: ["file-batch"],
      metadata: { "braintrust.batch_context": expect.any(String) },
    });
    const rows = (await backgroundLogger.drain()) as Array<
      Record<string, unknown>
    >;
    expect(rows).toHaveLength(3);
  });

  it("passes ordinary uploads through without tracing", async () => {
    const file = await mistralFilesUploadTraced({
      async upload(
        params: { file: Blob; purpose: string },
        options?: { timeout: number },
      ) {
        expect(options).toEqual({ timeout: 5 });
        return { id: `file-${params.purpose}` };
      },
    })({ file: new Blob(["document"]), purpose: "ocr" }, { timeout: 5 });

    expect(file.id).toBe("file-ocr");
    expect(await backgroundLogger.drain()).toEqual([]);
  });

  it("automatically ends pending spans when jobs.create rejects", async () => {
    const submissionError = new Error("submission rejected");
    let startedRows: Array<Record<string, unknown>> = [];
    const create = mistralBatchJobsCreateTraced({
      async create(_params: {
        requests: typeof requests;
        endpoint: "/v1/chat/completions";
        model: string;
        metadata?: Record<string, string>;
      }): Promise<never> {
        startedRows = (await backgroundLogger.drain()) as Array<
          Record<string, unknown>
        >;
        throw submissionError;
      },
    });

    await expect(
      create({
        requests,
        endpoint: "/v1/chat/completions",
        model: "mistral-small-latest",
      }),
    ).rejects.toBe(submissionError);

    expect(startedRows).toHaveLength(3);
    const completedRows = (await backgroundLogger.drain()) as Array<
      Record<string, any>
    >;
    expect(completedRows).toHaveLength(3);
    expect(
      completedRows.every((row) => row.error === "submission rejected"),
    ).toBe(true);
    expect(completedRows.every((row) => row.metrics?.end !== undefined)).toBe(
      true,
    );
  });

  it("completes inline batches with flattened arguments", async () => {
    let createParams: Record<string, any> | undefined;
    const batch = await mistralBatchJobsCreateTraced({
      async create(params: {
        requests: typeof requests;
        endpoint: "/v1/chat/completions";
        model: string;
        metadata?: Record<string, string>;
      }) {
        createParams = params;
        return {
          id: "batch-complete",
          endpoint: params.endpoint,
          model: params.model,
          metadata: params.metadata,
          status: "SUCCESS",
          totalRequests: 2,
          outputs: requests.map(({ customId }) => ({
            custom_id: customId,
            response: {
              status_code: 200,
              body: {
                model: params.model,
                choices: [
                  { message: { role: "assistant", content: customId } },
                ],
                usage: {
                  prompt_tokens: 1,
                  completion_tokens: 1,
                  total_tokens: 2,
                },
              },
            },
          })),
        };
      },
    })({
      requests,
      endpoint: "/v1/chat/completions",
      model: "mistral-small-latest",
    });
    await backgroundLogger.drain();

    const collectionContext = await completeMistralBatchTrace({
      batch: { ...batch, metadata: createParams?.metadata },
      requests,
    });

    expect(collectionContext).toEqual({
      version: 1,
      value: expect.any(String),
    });
    const rows = (await backgroundLogger.drain()) as Array<Record<string, any>>;
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.metrics?.end !== undefined)).toBe(true);
  });
});
