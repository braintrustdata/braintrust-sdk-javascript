import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { configureNode } from "../../node/config";
import { _exportsForTestingOnly, initLogger } from "../../logger";
import { langSmithChannels } from "./langsmith-channels";
import { LangSmithPlugin } from "./langsmith-plugin";

try {
  configureNode();
} catch {
  // Best-effort initialization for test environments.
}

describe("LangSmithPlugin", () => {
  let backgroundLogger: ReturnType<
    typeof _exportsForTestingOnly.useTestBackgroundLogger
  >;
  let plugin: LangSmithPlugin;

  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
  });

  beforeEach(() => {
    backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({
      projectName: "langsmith-plugin.test.ts",
      projectId: "test-project-id",
    });
    plugin = new LangSmithPlugin();
    plugin.enable();
  });

  afterEach(() => {
    plugin.disable();
    _exportsForTestingOnly.clearTestBackgroundLogger();
  });

  it("mirrors run lifecycle data with LangSmith IDs, timestamps, and metrics", async () => {
    const rootId = "11111111-1111-4111-8111-111111111111";
    const childId = "22222222-2222-4222-8222-222222222222";
    const start = new Date(Date.now() - 1000);
    const firstToken = new Date(start.getTime() + 250);
    const end = new Date(start.getTime() + 500);

    await langSmithChannels.batchIngestRuns.tracePromise(
      async () => undefined,
      {
        arguments: [
          {
            runCreates: [
              {
                id: childId,
                trace_id: rootId,
                parent_run_id: rootId,
                dotted_order: `20260713T000000000000Z${rootId}.20260713T000000000001Z${childId}`,
                name: "answer",
                run_type: "llm",
                start_time: start.toISOString(),
                inputs: { messages: ["hello"] },
                extra: {
                  metadata: {
                    customer: "acme",
                    ls_provider: "openai",
                    ls_model_name: "gpt-test",
                    ls_temperature: 0.2,
                    usage_metadata: { ignored: true },
                  },
                  runtime: { hidden: true },
                },
                tags: ["unit", 1],
                serialized: { secret: true },
                events: [{ name: "new_token", time: firstToken.toISOString() }],
              },
              {
                id: rootId,
                trace_id: rootId,
                name: "workflow",
                run_type: "chain",
                start_time: start.toISOString(),
                inputs: { question: "hello" },
              },
            ],
            runUpdates: [
              {
                id: childId,
                trace_id: rootId,
                parent_run_id: rootId,
                end_time: end.toISOString(),
                outputs: {
                  generations: ["world"],
                  usage_metadata: {
                    input_tokens: 3,
                    output_tokens: 2,
                    total_tokens: 5,
                    input_token_details: {
                      cache_read: 1,
                      cache_creation: 2,
                    },
                  },
                },
              },
              {
                id: rootId,
                trace_id: rootId,
                end_time: end.toISOString(),
                outputs: { answer: "world" },
              },
            ],
          },
        ],
      },
    );

    const spans = (await backgroundLogger.drain()) as any[];
    const root = spans.find((span) => span.span_id === rootId);
    const child = spans.find((span) => span.span_id === childId);

    expect(root).toMatchObject({
      id: rootId,
      span_id: rootId,
      root_span_id: rootId,
      span_parents: [],
      input: { question: "hello" },
      output: { answer: "world" },
      span_attributes: { name: "workflow", type: "task" },
    });
    expect(root?.metrics).toMatchObject({
      end: end.getTime() / 1000,
      start: start.getTime() / 1000,
    });
    expect(child).toMatchObject({
      id: childId,
      span_id: childId,
      root_span_id: rootId,
      span_parents: [rootId],
      input: { messages: ["hello"] },
      output: expect.objectContaining({ generations: ["world"] }),
      tags: ["unit"],
      metadata: {
        customer: "acme",
        provider: "openai",
        model: "gpt-test",
        temperature: 0.2,
      },
      metrics: {
        prompt_tokens: 3,
        completion_tokens: 2,
        tokens: 5,
        prompt_cached_tokens: 1,
        prompt_cache_creation_tokens: 2,
        time_to_first_token: 0.25,
      },
      span_attributes: { name: "answer", type: "llm" },
    });
    expect(child).not.toHaveProperty("serialized");
    expect(child.metadata).not.toHaveProperty("usage_metadata");
    expect(child.metadata).not.toHaveProperty("runtime");
  });

  it("deduplicates mixed lifecycle sources and tolerates update-only runs", async () => {
    const id = "33333333-3333-4333-8333-333333333333";
    const update = {
      id,
      trace_id: id,
      name: "update only",
      run_type: "retriever",
      outputs: { documents: [] },
      end_time: new Date().toISOString(),
    };

    await langSmithChannels.updateRun.tracePromise(async () => undefined, {
      arguments: [id, update],
    });
    await langSmithChannels.createRun.tracePromise(async () => undefined, {
      arguments: [update],
    });
    await langSmithChannels.batchIngestRuns.tracePromise(
      async () => undefined,
      { arguments: [{ runUpdates: [update] }] },
    );

    const spans = (await backgroundLogger.drain()) as any[];
    expect(spans.filter((span) => span.span_id === id)).toHaveLength(1);
    expect(spans.find((span) => span.span_id === id)).toMatchObject({
      output: { documents: [] },
      span_attributes: { name: "update only", type: "tool" },
    });
  });

  it("contains malformed and prototype-sensitive payloads", async () => {
    let getterCalled = false;
    const payload = Object.create({ id: "inherited-id", name: "inherited" });
    Object.defineProperty(payload, "outputs", {
      get() {
        getterCalled = true;
        throw new Error("must not execute");
      },
    });

    await expect(
      langSmithChannels.createRun.tracePromise(async () => undefined, {
        arguments: [payload],
      }),
    ).resolves.toBeUndefined();
    expect(getterCalled).toBe(false);
    expect(await backgroundLogger.drain()).toEqual([]);
  });

  it("suppresses LangChain-serialized runs only when configured", async () => {
    const run = {
      id: "44444444-4444-4444-8444-444444444444",
      trace_id: "44444444-4444-4444-8444-444444444444",
      name: "langchain runnable",
      serialized: { lc: 1 },
      end_time: new Date().toISOString(),
    };

    await langSmithChannels.updateRun.tracePromise(async () => undefined, {
      arguments: [run.id, run],
    });
    expect(await backgroundLogger.drain()).toEqual([]);

    plugin.disable();
    plugin = new LangSmithPlugin({ skipLangChainRuns: false });
    plugin.enable();
    await langSmithChannels.updateRun.tracePromise(async () => undefined, {
      arguments: [run.id, run],
    });
    expect(await backgroundLogger.drain()).toHaveLength(1);
  });

  it("bounds the completed-run deduplication cache", () => {
    const completedRuns = (
      plugin as unknown as {
        completedRuns: {
          get(key: string): true | undefined;
          set(key: string, value: true): void;
        };
      }
    ).completedRuns;

    for (let index = 0; index <= 10_000; index++) {
      completedRuns.set(`run-${index}`, true);
    }

    expect(completedRuns.get("run-0")).toBeUndefined();
    expect(completedRuns.get("run-10000")).toBe(true);
  });
});
