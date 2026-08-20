import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  _exportsForTestingOnly,
  _internalGetGlobalState,
  Attachment,
  initLogger,
  startSpan,
  withCurrent,
} from "../../logger";
import { configureNode } from "../../node/config";
import {
  completeMistralBatchTrace,
  failMistralBatchTrace,
  startMistralBatchTrace,
} from "../../mistral-batch";
import { BRAINTRUST_MISTRAL_BATCH_CONTEXT_KEY } from "./mistral-batch-constants";
import { MistralPlugin } from "./mistral-plugin";

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

function success(customId: string, content: string) {
  return {
    custom_id: customId,
    response: {
      status_code: 200,
      body: {
        id: `response-${customId}`,
        model: "mistral-small-latest",
        choices: [{ message: { role: "assistant", content } }],
        usage: {
          prompt_tokens: 2,
          completion_tokens: 1,
          total_tokens: 3,
        },
      },
    },
  };
}

describe("Mistral Batch instrumentation", () => {
  let backgroundLogger: ReturnType<
    typeof _exportsForTestingOnly.useTestBackgroundLogger
  >;
  let plugin: MistralPlugin;

  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
    _internalGetGlobalState()._internalSetTraceContextSigningSecret(
      "mistral-batch-test-secret",
    );
  });

  beforeEach(() => {
    backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({
      projectName: "mistral-batch-instrumentation.test.ts",
      projectId: "test-project-id",
    });
    plugin = new MistralPlugin();
    plugin.enable();
  });

  afterEach(() => {
    plugin.disable();
    _exportsForTestingOnly.clearTestBackgroundLogger();
  });

  it("prepares inline parameters and starts pending spans", async () => {
    const sourceParams = {
      endpoint: "/v1/chat/completions" as const,
      model: "mistral-small-latest",
      metadata: { owner: "sdk" },
    };
    const params = await startMistralBatchTrace({
      input: { requests },
      params: sourceParams,
    });

    expect(params).toMatchObject({
      endpoint: "/v1/chat/completions",
      model: "mistral-small-latest",
      requests,
      metadata: {
        owner: "sdk",
        [BRAINTRUST_MISTRAL_BATCH_CONTEXT_KEY]: expect.any(String),
      },
    });
    expect(sourceParams.metadata).toEqual({ owner: "sdk" });

    const rows = (await backgroundLogger.drain()) as Array<Record<string, any>>;
    expect(rows).toHaveLength(3);
    const task = rows.find(
      (row) => row.span_attributes?.name === "mistral.batch",
    );
    const children = rows.filter(
      (row) => row.span_attributes?.name === "mistral.chat.complete",
    );
    expect(task).toMatchObject({
      metadata: { provider: "mistral" },
      span_attributes: { type: "task" },
      span_parents: [],
    });
    expect(task?.input).toBeUndefined();
    expect(task?.metrics).not.toHaveProperty("end");
    expect(children).toHaveLength(2);
    expect(children.map((row) => row.input[0].content).sort()).toEqual([
      "first",
      "second",
    ]);
    expect(children[0].metadata).toMatchObject({
      model: "mistral-small-latest",
      provider: "mistral",
    });
    expect(children[0].metrics).not.toHaveProperty("end");
  });

  it("traces agent batches and records the resolved response model", async () => {
    const input = { requests: [requests[0]] };
    const params = await startMistralBatchTrace({
      input,
      params: {
        endpoint: "/v1/chat/completions",
        agentId: "agent-123",
      },
    });

    expect(params).toMatchObject({
      agentId: "agent-123",
      metadata: {
        [BRAINTRUST_MISTRAL_BATCH_CONTEXT_KEY]: expect.any(String),
      },
    });
    const serializedContext = JSON.parse(
      params.metadata?.[BRAINTRUST_MISTRAL_BATCH_CONTEXT_KEY] ?? "{}",
    );
    expect(serializedContext).toMatchObject({ agentId: "agent-123" });
    expect(serializedContext).not.toHaveProperty("model");
    const startedRows = (await backgroundLogger.drain()) as Array<
      Record<string, any>
    >;
    const startedChild = startedRows.find(
      (row) => row.span_attributes?.name === "mistral.chat.complete",
    );
    expect(startedChild?.metadata).toMatchObject({
      agent_id: "agent-123",
      provider: "mistral",
    });
    expect(startedChild?.metadata).not.toHaveProperty("model");

    await completeMistralBatchTrace({
      batch: {
        id: "batch-agent",
        endpoint: params.endpoint,
        agentId: params.agentId,
        model: null,
        status: "SUCCESS",
        totalRequests: 1,
        metadata: params.metadata,
        outputs: [success("one", "A")],
      },
      input,
    });

    const completedRows = (await backgroundLogger.drain()) as Array<
      Record<string, any>
    >;
    expect(completedRows).toHaveLength(2);
    expect(
      completedRows.find((row) => row.id === startedChild?.id)?.metadata,
    ).toMatchObject({ model: "mistral-small-latest" });
  });

  it("preserves propagated events on signed and collect-only batch spans", async () => {
    const assertPropagation = (rows: Array<Record<string, any>>): void => {
      const batchRows = rows.filter((row) =>
        ["mistral.batch", "mistral.chat.complete"].includes(
          row.span_attributes?.name,
        ),
      );
      expect(batchRows).toHaveLength(2);
      expect(
        batchRows.every(
          (row) => row.metadata?.propagated === "batch-descendant",
        ),
      ).toBe(true);
      expect(batchRows.every((row) => row.tags?.includes("batch-tag"))).toBe(
        true,
      );
    };
    const input = { requests: [requests[0]] };

    const signedParent = startSpan({
      name: "signed-parent",
      propagatedEvent: {
        metadata: { propagated: "batch-descendant" },
        tags: ["batch-tag"],
      },
    });
    await withCurrent(signedParent, () =>
      startMistralBatchTrace({
        input,
        params: {
          endpoint: "/v1/chat/completions",
          model: "mistral-small-latest",
        },
      }),
    );
    signedParent.end();
    assertPropagation(
      (await backgroundLogger.drain()) as Array<Record<string, any>>,
    );

    const collectParent = startSpan({
      name: "collect-parent",
      propagatedEvent: {
        metadata: { propagated: "batch-descendant" },
        tags: ["batch-tag"],
      },
    });
    await withCurrent(collectParent, () =>
      completeMistralBatchTrace({
        batch: {
          id: "batch-propagated-collect-only",
          endpoint: "/v1/chat/completions",
          model: "mistral-small-latest",
          status: "SUCCESS",
          totalRequests: 1,
          outputs: [success("one", "A")],
        },
        input,
      }),
    );
    collectParent.end();
    assertPropagation(
      (await backgroundLogger.drain()) as Array<Record<string, any>>,
    );
  });

  it("removes signed context and closes initialized spans when startup fails", async () => {
    const recursiveMessages: any[] = [];
    recursiveMessages.push(recursiveMessages);
    Object.defineProperty(recursiveMessages, "toJSON", {
      value: () => [{ role: "user", content: "serializable" }],
    });
    const traceErrors: Error[] = [];

    const params = await startMistralBatchTrace({
      input: {
        requests: [
          requests[0],
          {
            customId: "startup-failure",
            body: { messages: recursiveMessages },
          },
        ],
      },
      params: {
        endpoint: "/v1/chat/completions",
        model: "mistral-small-latest",
      },
      onTraceError: (error) => {
        traceErrors.push(error);
      },
    });

    expect(params.metadata).toBeUndefined();
    expect(traceErrors).toHaveLength(1);
    const rows = (await backgroundLogger.drain()) as Array<Record<string, any>>;
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.metrics?.end !== undefined)).toBe(true);
    expect(rows.every((row) => typeof row.error === "string")).toBe(true);
  });

  it("uses provider JSON semantics when correlating inline inputs", async () => {
    const params = await startMistralBatchTrace({
      input: {
        requests: [
          {
            customId: "json-semantics",
            body: {
              messages: [{ role: "user", content: "hello" }],
              optional: undefined,
              stop: [undefined, "done"],
            },
          },
        ],
      },
      params: {
        endpoint: "/v1/chat/completions",
        model: "mistral-small-latest",
      },
    });
    await backgroundLogger.drain();

    await completeMistralBatchTrace({
      batch: {
        id: "batch-json-semantics",
        endpoint: params.endpoint,
        model: params.model,
        status: "SUCCESS",
        totalRequests: 1,
        metadata: params.metadata,
      },
      outputContent: [success("json-semantics", "Hi")],
      input: {
        requests: [
          {
            customId: "json-semantics",
            body: {
              messages: [{ role: "user", content: "hello" }],
              stop: [null, "done"],
            },
          },
        ],
      },
    });

    const rows = (await backgroundLogger.drain()) as Array<Record<string, any>>;
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.metrics?.end !== undefined)).toBe(true);
  });

  it("uses locale-independent key ordering for input correlation", async () => {
    const startLocaleCompare = vi
      .spyOn(String.prototype, "localeCompare")
      .mockImplementation(() => {
        throw new Error("locale-dependent comparison was used");
      });
    let params: Awaited<ReturnType<typeof startMistralBatchTrace>>;
    try {
      params = await startMistralBatchTrace({
        input: {
          requests: [
            {
              customId: "unicode-keys",
              body: {
                messages: [{ role: "user", content: "hello" }],
                z: 1,
                ä: 2,
              },
            },
          ],
        },
        params: {
          endpoint: "/v1/chat/completions",
          model: "mistral-small-latest",
        },
      });
    } finally {
      startLocaleCompare.mockRestore();
    }
    await backgroundLogger.drain();

    const completeLocaleCompare = vi
      .spyOn(String.prototype, "localeCompare")
      .mockImplementation(() => {
        throw new Error("locale-dependent comparison was used");
      });
    try {
      await completeMistralBatchTrace({
        batch: {
          id: "batch-unicode-keys",
          endpoint: params.endpoint,
          model: params.model,
          status: "SUCCESS",
          totalRequests: 1,
          metadata: params.metadata,
        },
        outputContent: [success("unicode-keys", "Hi")],
        input: {
          requests: [
            {
              customId: "unicode-keys",
              body: {
                ä: 2,
                z: 1,
                messages: [{ role: "user", content: "hello" }],
              },
            },
          ],
        },
      });
    } finally {
      completeLocaleCompare.mockRestore();
    }

    const rows = (await backgroundLogger.drain()) as Array<Record<string, any>>;
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.metrics?.end !== undefined)).toBe(true);
  });

  it("accepts nullable fields from Mistral BatchJob values", async () => {
    interface ProviderBatchJob {
      id: string;
      inputFiles: string[];
      metadata?: Record<string, unknown> | null;
      endpoint: string;
      model?: string | null;
      outputs?: Array<Record<string, unknown>> | null;
      outputFile?: string | null;
      errorFile?: string | null;
      status: string;
      createdAt: number;
      totalRequests: number;
      completedRequests: number;
      succeededRequests: number;
      failedRequests: number;
    }

    const input = { requests: [requests[0]] };
    const params = await startMistralBatchTrace({
      input,
      params: {
        endpoint: "/v1/chat/completions",
        model: "mistral-small-latest",
      },
    });
    await backgroundLogger.drain();

    const batch: ProviderBatchJob = {
      id: "batch-nullable-provider-fields",
      inputFiles: [],
      metadata: params.metadata,
      endpoint: params.endpoint,
      model: null,
      outputs: null,
      outputFile: "provider-output-file-id",
      errorFile: null,
      status: "SUCCESS",
      createdAt: 1,
      totalRequests: 1,
      completedRequests: 1,
      succeededRequests: 1,
      failedRequests: 0,
    };
    const completed = await completeMistralBatchTrace({
      batch,
      input,
      outputContent: [success("one", "A")],
    });

    expect(completed.batch).toBe(batch);
    expect(completed.collectionContext).toEqual({
      version: 1,
      value: expect.any(String),
    });
    const rows = (await backgroundLogger.drain()) as Array<Record<string, any>>;
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.metrics?.end !== undefined)).toBe(true);
  });

  it("keeps explicit batch tracing enabled when the Mistral plugin is disabled", async () => {
    plugin.disable();

    const params = await startMistralBatchTrace({
      input: { requests },
      params: {
        endpoint: "/v1/chat/completions",
        model: "mistral-small-latest",
      },
    });

    expect(params.metadata).toHaveProperty(
      BRAINTRUST_MISTRAL_BATCH_CONTEXT_KEY,
    );
    expect(await backgroundLogger.drain()).toHaveLength(3);
  });

  it("supports multiple input files and preserves provider-ready ids", async () => {
    const params = await startMistralBatchTrace({
      input: {
        files: [
          {
            file: { id: "file-one" },
            content: `${JSON.stringify({ custom_id: "one", body: requests[0].body })}\n`,
          },
          {
            file: { id: "file-two" },
            content: [{ custom_id: "two", body: requests[1].body }],
          },
        ],
      },
      params: {
        endpoint: "/v1/chat/completions",
        model: "mistral-small-latest",
      },
    });

    expect(params.inputFiles).toEqual(["file-one", "file-two"]);
    expect(params.requests).toBeUndefined();
    expect(await backgroundLogger.drain()).toHaveLength(3);
  });

  it("reopens one-shot input sources across the batch lifecycle", async () => {
    let sourceReads = 0;
    const input = {
      files: [
        {
          file: { id: "response-file" },
          content: () => {
            sourceReads++;
            return new Response(
              requests
                .map(({ customId, body }) =>
                  JSON.stringify({ custom_id: customId, body }),
                )
                .join("\n"),
            );
          },
        },
      ],
    };
    const params = await startMistralBatchTrace({
      input,
      params: {
        endpoint: "/v1/chat/completions",
        model: "mistral-small-latest",
      },
    });
    await backgroundLogger.drain();

    await completeMistralBatchTrace({
      batch: {
        id: "batch-response-input",
        endpoint: params.endpoint,
        model: params.model,
        status: "SUCCESS",
        totalRequests: 2,
        inputFiles: ["response-file"],
        metadata: params.metadata,
      },
      outputContent: [success("one", "A"), success("two", "B")],
      input,
    });

    expect(sourceReads).toBeGreaterThanOrEqual(2);
    const rows = (await backgroundLogger.drain()) as Array<Record<string, any>>;
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.metrics?.end !== undefined)).toBe(true);
  });

  it("captures canonical tool configuration on batch children", async () => {
    await startMistralBatchTrace({
      input: {
        requests: [
          {
            customId: "tool-request",
            body: {
              messages: [{ role: "user", content: "look this up" }],
              toolChoice: "any",
              parallelToolCalls: false,
              tools: [
                {
                  type: "function",
                  function: {
                    name: "lookup",
                    description: "Look something up",
                    parameters: { type: "object" },
                  },
                },
              ],
            },
          },
        ],
      },
      params: {
        endpoint: "/v1/chat/completions",
        model: "mistral-small-latest",
      },
    });

    const rows = (await backgroundLogger.drain()) as Array<Record<string, any>>;
    const child = rows.find(
      (row) => row.span_attributes?.name === "mistral.chat.complete",
    );
    expect(child?.metadata).toMatchObject({
      tool_choice: "required",
      parallel_tool_calls: false,
      tools: [
        {
          type: "function",
          function: {
            name: "lookup",
            description: "Look something up",
            parameters: { type: "object" },
          },
        },
      ],
    });
  });

  it("completes signed spans out of order and returns the exact batch", async () => {
    const params = await startMistralBatchTrace({
      input: { requests },
      params: {
        endpoint: "/v1/chat/completions",
        model: "mistral-small-latest",
      },
    });
    const startedRows = (await backgroundLogger.drain()) as Array<
      Record<string, any>
    >;
    const startedChildren = startedRows.filter(
      (row) => row.span_attributes?.name === "mistral.chat.complete",
    );
    const childIds = new Set(startedChildren.map((row) => row.id));
    const taskId = startedRows.find(
      (row) => row.span_attributes?.name === "mistral.batch",
    )?.id;
    const batch = {
      id: "batch-signed",
      endpoint: params.endpoint,
      model: params.model,
      status: "SUCCESS",
      totalRequests: 2,
      metadata: params.metadata,
      outputs: [success("two", "B"), success("one", "A")],
    };

    const returned = await completeMistralBatchTrace({
      batch,
      input: { requests },
    });
    expect(returned.batch).toBe(batch);

    const rows = (await backgroundLogger.drain()) as Array<Record<string, any>>;
    expect(rows).toHaveLength(3);
    const children = rows.filter((row) => childIds.has(row.id));
    expect(children).toHaveLength(2);
    expect(children.every((row) => row.input === undefined)).toBe(true);
    expect(children.every((row) => row.span_attributes === undefined)).toBe(
      true,
    );
    for (const child of children) {
      const started = startedChildren.find((row) => row.id === child.id);
      expect(child.root_span_id).toBe(started?.root_span_id);
      expect(child.span_parents).toEqual(started?.span_parents);
    }
    expect(children.map((row) => row.output[0].message.content).sort()).toEqual(
      ["A", "B"],
    );
    expect(children[0].metrics).toMatchObject({
      prompt_tokens: 2,
      completion_tokens: 1,
      tokens: 3,
      end: expect.any(Number),
    });
    expect(rows.find((row) => row.id === taskId)?.metrics).toHaveProperty(
      "end",
    );
  });

  it("resumes signed attachment spans without rewriting their input", async () => {
    const dataUrl = "data:image/png;base64,aGVsbG8gd29ybGQ=";
    const input = {
      requests: [
        {
          customId: "attachment-input",
          body: {
            messages: [
              {
                role: "user",
                content: [{ type: "image_url", image_url: { url: dataUrl } }],
              },
            ],
          },
        },
      ],
    };
    const params = await startMistralBatchTrace({
      input,
      params: {
        endpoint: "/v1/chat/completions",
        model: "mistral-small-latest",
      },
    });
    const startedRows = (await backgroundLogger.drain()) as Array<
      Record<string, any>
    >;
    const startedChild = startedRows.find(
      (row) => row.span_attributes?.name === "mistral.chat.complete",
    );
    const attachment = startedChild?.input?.[0]?.content?.[0]?.image_url?.url;
    expect(attachment).toBeInstanceOf(Attachment);

    const batch = {
      id: "batch-signed-attachment-retry",
      endpoint: params.endpoint,
      model: params.model,
      status: "SUCCESS",
      totalRequests: 1,
      metadata: params.metadata,
    };
    const outputContent = [success("attachment-input", "A")];
    for (let retry = 0; retry < 2; retry++) {
      await completeMistralBatchTrace({ batch, input, outputContent });
      const rows = (await backgroundLogger.drain()) as Array<
        Record<string, any>
      >;
      const child = rows.find((row) => row.id === startedChild?.id);
      expect(child?.input).toBeUndefined();
      expect(child?.span_attributes).toBeUndefined();
      expect(child?.metrics?.end).toEqual(expect.any(Number));
    }
  });

  it("ends pending spans when submission fails", async () => {
    const params = await startMistralBatchTrace({
      input: { requests },
      params: {
        endpoint: "/v1/chat/completions",
        model: "mistral-small-latest",
      },
    });
    await backgroundLogger.drain();

    await failMistralBatchTrace({
      params,
      input: { requests },
      error: new Error("submission rejected"),
    });
    const rows = (await backgroundLogger.drain()) as Array<Record<string, any>>;
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.metrics?.end !== undefined)).toBe(true);
    expect(rows.every((row) => row.error === "submission rejected")).toBe(true);
  });

  it("reports mismatched file ids when submission fails", async () => {
    const input = {
      files: [
        {
          file: { id: "expected-file" },
          content: [
            { custom_id: requests[0].customId, body: requests[0].body },
          ],
        },
      ],
    };
    const params = await startMistralBatchTrace({
      input,
      params: {
        endpoint: "/v1/chat/completions",
        model: "mistral-small-latest",
      },
    });
    await backgroundLogger.drain();
    const traceErrors: Error[] = [];

    await failMistralBatchTrace({
      params: { ...params, inputFiles: ["different-file"] },
      input,
      error: new Error("submission rejected"),
      onTraceError: (error) => {
        traceErrors.push(error);
      },
    });

    expect(traceErrors).toHaveLength(1);
    expect(traceErrors[0].message).toContain("file ids do not match");
    expect(await backgroundLogger.drain()).toHaveLength(0);
  });

  it("closes failed batches despite a provider request-count mismatch", async () => {
    const params = await startMistralBatchTrace({
      input: { requests },
      params: {
        endpoint: "/v1/chat/completions",
        model: "mistral-small-latest",
      },
    });
    const startedRows = (await backgroundLogger.drain()) as Array<
      Record<string, any>
    >;
    const idsByInput = new Map(
      startedRows
        .filter((row) => row.input?.[0]?.content)
        .map((row) => [row.input[0].content, row.id]),
    );
    const taskId = startedRows.find(
      (row) => row.span_attributes?.name === "mistral.batch",
    )?.id;

    await completeMistralBatchTrace({
      batch: {
        id: "batch-failed-count-mismatch",
        endpoint: params.endpoint,
        model: params.model,
        status: "FAILED",
        totalRequests: 1,
        metadata: params.metadata,
      },
      outputContent: [success("one", "A")],
      input: { requests },
    });

    const rows = (await backgroundLogger.drain()) as Array<Record<string, any>>;
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.metrics?.end !== undefined)).toBe(true);
    expect(rows.find((row) => row.id === taskId)?.error).toBe(
      "Mistral Batch FAILED",
    );
    expect(rows.find((row) => row.id === idsByInput.get("second"))?.error).toBe(
      "Mistral Batch FAILED",
    );
    expect(
      rows.find((row) => row.id === idsByInput.get("first"))?.output?.[0]
        ?.message?.content,
    ).toBe("A");
  });

  it("closes every signed child when failed input reconstruction is partial", async () => {
    const params = await startMistralBatchTrace({
      input: { requests },
      params: {
        endpoint: "/v1/chat/completions",
        model: "mistral-small-latest",
      },
    });
    const startedRows = (await backgroundLogger.drain()) as Array<
      Record<string, any>
    >;
    const taskId = startedRows.find(
      (row) => row.span_attributes?.name === "mistral.batch",
    )?.id;

    await completeMistralBatchTrace({
      batch: {
        id: "batch-failed-partial-input",
        endpoint: params.endpoint,
        model: params.model,
        status: "FAILED",
        totalRequests: 2,
        metadata: params.metadata,
      },
      outputContent: [success("one", "A")],
      input: {
        requests: [requests[0], { customId: "", body: requests[1].body }],
      },
    });

    const rows = (await backgroundLogger.drain()) as Array<Record<string, any>>;
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.metrics?.end !== undefined)).toBe(true);
    expect(rows.find((row) => row.id === taskId)?.error).toBe(
      "Mistral Batch FAILED",
    );
    expect(
      rows.some(
        (row) => row.output?.[0]?.message?.content === "A" && !row.error,
      ),
    ).toBe(true);
  });

  it("collects a terminal batch without prior signed metadata", async () => {
    const batch = {
      id: "batch-collect-only",
      endpoint: "/v1/chat/completions",
      model: "mistral-small-latest",
      status: "SUCCESS",
      totalRequests: 2,
      createdAt: 1000,
      startedAt: 1500,
      completedAt: 2000,
    };

    await completeMistralBatchTrace({
      batch,
      input: { requests },
      outputContent: [success("one", "A"), success("two", "B")],
    });
    const rows = (await backgroundLogger.drain()) as Array<Record<string, any>>;
    expect(rows).toHaveLength(3);
    expect(
      rows.filter(
        (row) => row.span_attributes?.name === "mistral.chat.complete",
      ),
    ).toHaveLength(2);
    expect(rows.every((row) => row.metrics?.end !== undefined)).toBe(true);
    expect(
      rows.find((row) => row.span_attributes?.name === "mistral.batch")?.metrics
        ?.start,
    ).toBe(1000);
    expect(
      rows
        .filter((row) => row.span_attributes?.name === "mistral.chat.complete")
        .every((row) => row.metrics?.start === 1500),
    ).toBe(true);
    expect(rows.every((row) => row.metrics?.end === 2000)).toBe(true);
  });

  it("rejects mismatched collect-only terminal batches", async () => {
    const countErrors: Error[] = [];
    await completeMistralBatchTrace({
      batch: {
        id: "batch-collect-only-failed-count-mismatch",
        endpoint: "/v1/chat/completions",
        model: "mistral-small-latest",
        status: "FAILED",
        totalRequests: 1,
      },
      input: { requests },
      onTraceError: (error) => {
        countErrors.push(error);
      },
    });

    expect(countErrors.at(-1)?.message).toContain("request count");
    expect(await backgroundLogger.drain()).toHaveLength(0);

    const fileErrors: Error[] = [];
    await completeMistralBatchTrace({
      batch: {
        id: "batch-collect-only-cancelled-file-mismatch",
        endpoint: "/v1/chat/completions",
        model: "mistral-small-latest",
        status: "CANCELLED",
        totalRequests: 1,
        inputFiles: ["different-file"],
      },
      input: {
        files: [
          {
            file: { id: "expected-file" },
            content: [
              { custom_id: requests[0].customId, body: requests[0].body },
            ],
          },
        ],
      },
      onTraceError: (error) => {
        fileErrors.push(error);
      },
    });

    expect(fileErrors.at(-1)?.message).toContain("input files");
    expect(await backgroundLogger.drain()).toHaveLength(0);
  });

  it("falls back to collect-only for invalid tracing metadata", async () => {
    await completeMistralBatchTrace({
      batch: {
        id: "batch-invalid",
        endpoint: "/v1/chat/completions",
        model: "mistral-small-latest",
        status: "SUCCESS",
        totalRequests: 2,
        metadata: { [BRAINTRUST_MISTRAL_BATCH_CONTEXT_KEY]: "tampered" },
      },
      outputContent: [success("one", "A"), success("two", "B")],
      input: { requests },
    });
    expect(await backgroundLogger.drain()).toHaveLength(3);
  });

  it("returns context that keeps collect-only retries on the same trace", async () => {
    const batch = {
      id: "batch-collect-only-retry",
      endpoint: "/v1/chat/completions",
      model: "mistral-small-latest",
      status: "SUCCESS",
      totalRequests: 2,
    };
    const outputContent = [success("one", "A"), success("two", "B")];

    let collectionContext:
      | Awaited<
          ReturnType<typeof completeMistralBatchTrace>
        >["collectionContext"]
      | undefined;
    const collectUnderParent = async (name: string) => {
      const parent = startSpan({ name });
      const result = await withCurrent(parent, () =>
        completeMistralBatchTrace({
          batch,
          input: { requests },
          ...(collectionContext ? { collectionContext } : {}),
          outputContent,
        }),
      );
      collectionContext ??= result.collectionContext;
      parent.end();
      const rows = (await backgroundLogger.drain()) as Array<
        Record<string, any>
      >;
      return rows
        .filter((row) =>
          ["mistral.batch", "mistral.chat.complete"].includes(
            row.span_attributes?.name,
          ),
        )
        .map((row) => ({
          id: row.id,
          rootSpanId: row.root_span_id,
          spanParents: row.span_parents,
        }))
        .sort((left, right) => left.id.localeCompare(right.id));
    };

    expect(await collectUnderParent("first-collection-parent")).toEqual(
      await collectUnderParent("second-collection-parent"),
    );
    expect(collectionContext).toEqual({
      version: 1,
      value: expect.any(String),
    });
  });

  it("uses stable collect-only attachment identities for inputs and outputs", async () => {
    const dataUrl = "data:image/png;base64,aGVsbG8gd29ybGQ=";
    const input = {
      requests: [
        {
          customId: "collect-attachment",
          body: {
            messages: [
              {
                role: "user",
                content: [{ type: "image_url", image_url: { url: dataUrl } }],
              },
            ],
          },
        },
      ],
    };
    const batch = {
      id: "batch-collect-only-attachments",
      endpoint: "/v1/chat/completions",
      model: "mistral-small-latest",
      status: "SUCCESS",
      totalRequests: 1,
    };
    const outputContent = [
      {
        custom_id: "collect-attachment",
        response: {
          status_code: 200,
          body: {
            choices: [
              {
                message: {
                  role: "assistant",
                  content: [{ type: "image_url", image_url: { url: dataUrl } }],
                },
              },
            ],
          },
        },
      },
    ];
    let collectionContext:
      | Awaited<
          ReturnType<typeof completeMistralBatchTrace>
        >["collectionContext"]
      | undefined;
    const collectKeys = async () => {
      const result = await completeMistralBatchTrace({
        batch,
        input,
        ...(collectionContext ? { collectionContext } : {}),
        outputContent,
      });
      collectionContext ??= result.collectionContext;
      const rows = (await backgroundLogger.drain()) as Array<
        Record<string, any>
      >;
      const child = rows.find(
        (row) => row.span_attributes?.name === "mistral.chat.complete",
      );
      const inputAttachment = child?.input?.[0]?.content?.[0]?.image_url?.url;
      const outputAttachment =
        child?.output?.[0]?.message?.content?.[0]?.image_url?.url;
      expect(inputAttachment).toBeInstanceOf(Attachment);
      expect(outputAttachment).toBeInstanceOf(Attachment);
      return {
        input: inputAttachment.reference.key,
        output: outputAttachment.reference.key,
      };
    };

    const first = await collectKeys();
    const second = await collectKeys();
    expect(second).toEqual(first);
    expect(first.output).not.toBe(first.input);
    expect(first.input).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(first.output).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("uses a new trace for independent collections without retry context", async () => {
    const batch = {
      id: "batch-collect-only-parent-scope",
      endpoint: "/v1/chat/completions",
      model: "mistral-small-latest",
      status: "SUCCESS",
      totalRequests: 2,
    };
    const outputContent = [success("one", "A"), success("two", "B")];
    const collectIds = async (name: string) => {
      const parent = startSpan({ name });
      await withCurrent(parent, () =>
        completeMistralBatchTrace({
          batch,
          input: { requests },
          outputContent,
        }),
      );
      parent.end();
      return ((await backgroundLogger.drain()) as Array<Record<string, any>>)
        .filter((row) => row.span_attributes?.name === "mistral.batch")
        .map((row) => row.id);
    };

    expect(await collectIds("first-parent")).not.toEqual(
      await collectIds("second-parent"),
    );
  });

  it("leaves a successful batch pending when choices are missing or malformed", async () => {
    const params = await startMistralBatchTrace({
      input: { requests },
      params: {
        endpoint: "/v1/chat/completions",
        model: "mistral-small-latest",
      },
    });
    await backgroundLogger.drain();

    await completeMistralBatchTrace({
      batch: {
        id: "batch-malformed-result",
        endpoint: params.endpoint,
        model: params.model,
        status: "SUCCESS",
        totalRequests: 2,
        metadata: params.metadata,
      },
      outputContent: [
        {
          custom_id: "one",
          response: { status_code: 200, body: { id: "response-one" } },
        },
        {
          custom_id: "two",
          response: { status_code: 200, body: { choices: {} } },
        },
      ],
      input: { requests },
    });

    expect(await backgroundLogger.drain()).toHaveLength(0);
  });

  it("completes a fully correlated batch despite unrelated result records", async () => {
    const params = await startMistralBatchTrace({
      input: { requests },
      params: {
        endpoint: "/v1/chat/completions",
        model: "mistral-small-latest",
      },
    });
    await backgroundLogger.drain();
    const traceErrors: Error[] = [];

    await completeMistralBatchTrace({
      batch: {
        id: "batch-extra-results",
        endpoint: params.endpoint,
        model: params.model,
        status: "SUCCESS",
        totalRequests: 2,
        metadata: params.metadata,
      },
      input: { requests },
      outputContent: [
        success("unknown", "ignored"),
        { malformed: true },
        success("one", "A"),
        success("one", "duplicate"),
        success("two", "B"),
      ],
      onTraceError: (error) => {
        traceErrors.push(error);
      },
    });

    expect(traceErrors).toHaveLength(1);
    const rows = (await backgroundLogger.drain()) as Array<Record<string, any>>;
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.metrics?.end !== undefined)).toBe(true);
  });

  it("creates pending collect-only children for missing success results", async () => {
    const traceErrors: Error[] = [];
    await completeMistralBatchTrace({
      batch: {
        id: "batch-collect-only-incomplete",
        endpoint: "/v1/chat/completions",
        model: "mistral-small-latest",
        status: "SUCCESS",
        totalRequests: 2,
      },
      input: { requests },
      outputContent: [success("one", "A")],
      onTraceError: (error) => {
        traceErrors.push(error);
      },
    });

    expect(traceErrors.at(-1)?.message).toContain("results are incomplete");
    const rows = (await backgroundLogger.drain()) as Array<Record<string, any>>;
    expect(rows).toHaveLength(3);
    const task = rows.find(
      (row) => row.span_attributes?.name === "mistral.batch",
    );
    const children = rows.filter(
      (row) => row.span_attributes?.name === "mistral.chat.complete",
    );
    expect(task?.metrics?.end).toBeUndefined();
    expect(children).toHaveLength(2);
    expect(
      children.filter((row) => row.metrics?.end === undefined),
    ).toHaveLength(1);
  });

  it("stops reading results once every input is correlated", async () => {
    let reads = 0;
    async function* outputs() {
      reads++;
      yield success("one", "A");
      reads++;
      throw new Error("result source was read after correlation completed");
    }

    const input = { requests: [requests[0]] };
    const params = await startMistralBatchTrace({
      input,
      params: {
        endpoint: "/v1/chat/completions",
        model: "mistral-small-latest",
      },
    });
    await backgroundLogger.drain();

    await completeMistralBatchTrace({
      batch: {
        id: "batch-stop-after-correlation",
        endpoint: params.endpoint,
        model: params.model,
        status: "SUCCESS",
        totalRequests: 1,
        metadata: params.metadata,
      },
      outputContent: outputs(),
      input,
    });

    expect(reads).toBe(1);
    const rows = (await backgroundLogger.drain()) as Array<Record<string, any>>;
    expect(rows.every((row) => row.metrics?.end !== undefined)).toBe(true);
  });

  it("cancels a result stream after every input is correlated", async () => {
    let cancelled = false;
    const encodedResult = new TextEncoder().encode(
      `${JSON.stringify(success("one", "A"))}\n`,
    );
    const outputFile = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encodedResult);
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
    const input = { requests: [requests[0]] };
    const params = await startMistralBatchTrace({
      input,
      params: {
        endpoint: "/v1/chat/completions",
        model: "mistral-small-latest",
      },
    });
    await backgroundLogger.drain();

    await completeMistralBatchTrace({
      batch: {
        id: "batch-cancel-result-stream",
        endpoint: params.endpoint,
        model: params.model,
        status: "SUCCESS",
        totalRequests: 1,
        metadata: params.metadata,
      },
      input,
      outputContent: outputFile,
    });

    expect(cancelled).toBe(true);
  });

  it("bounds result records and reports truncated correlation", async () => {
    const input = { requests: [requests[0]] };
    const params = await startMistralBatchTrace({
      input,
      params: {
        endpoint: "/v1/chat/completions",
        model: "mistral-small-latest",
      },
    });
    await backgroundLogger.drain();

    const traceErrors: Error[] = [];
    await completeMistralBatchTrace({
      batch: {
        id: "batch-result-record-limit",
        endpoint: params.endpoint,
        model: params.model,
        status: "SUCCESS",
        totalRequests: 1,
        metadata: params.metadata,
      },
      outputContent: [
        ...Array.from({ length: 18 }, (_, index) =>
          success(`unknown-${index}`, "ignored"),
        ),
        success("one", "A"),
      ],
      input,
      onTraceError: (error) => {
        traceErrors.push(error);
      },
    });

    expect(traceErrors.at(-1)?.message).toContain("tracing record limit");
    const rows = (await backgroundLogger.drain()) as Array<Record<string, any>>;
    expect(rows.every((row) => row.metrics?.end === undefined)).toBe(true);
  });

  it("declines batches above the provider request limit without partial spans", async () => {
    const oversizedRequests = Array.from({ length: 100_001 }, (_, index) => ({
      customId: `request-${index}`,
      body: { messages: [{ role: "user", content: "hello" }] },
    }));

    const traceErrors: Error[] = [];
    const params = await startMistralBatchTrace({
      input: { requests: oversizedRequests },
      params: {
        endpoint: "/v1/chat/completions",
        model: "mistral-small-latest",
      },
      onTraceError: (error) => {
        traceErrors.push(error);
      },
    });

    expect(params.metadata).toBeUndefined();
    expect(traceErrors[0]?.message).toContain("correlation record limit");
    expect(await backgroundLogger.drain()).toHaveLength(0);
  });
});
