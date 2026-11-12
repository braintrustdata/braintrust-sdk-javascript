import type { Context } from "@temporalio/activity";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { createBraintrustActivityInterceptor } from "./interceptors";
import { serializeTraceContext } from "./utils";

const mock = vi.hoisted(() => {
  const span = { log: vi.fn(), end: vi.fn() };
  return { span, startSpan: vi.fn(() => span) };
});

vi.mock("braintrust", () => ({
  startSpan: mock.startSpan,
  withCurrent: <R>(_span: unknown, callback: () => R): R => callback(),
}));

beforeEach(() => vi.clearAllMocks());

describe.each([
  {
    name: "workflow",
    workflowExecution: { workflowId: "workflow", runId: "run" },
  },
  { name: "standalone", workflowExecution: undefined },
])("$name activity", ({ workflowExecution }) => {
  const context = {
    info: {
      activityId: "activity",
      activityType: "generate",
      workflowExecution,
    },
  } as Context;

  test("runs the activity and preserves parent context and output", async () => {
    const interceptor = createBraintrustActivityInterceptor(context).inbound!;
    const input = {
      args: ["prompt"],
      headers: serializeTraceContext({
        traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
      }),
    };
    const output = { text: "result" };
    const next = vi.fn().mockResolvedValue(output);

    await expect(interceptor.execute!(input, next)).resolves.toBe(output);
    expect(next).toHaveBeenCalledExactlyOnceWith(input);
    expect(mock.startSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        parent: {
          traceparent:
            "00-11111111111111111111111111111111-2222222222222222-01",
        },
        event: {
          metadata: {
            "temporal.activity_type": "generate",
            "temporal.activity_id": "activity",
            "temporal.workflow_id": workflowExecution?.workflowId,
            "temporal.workflow_run_id": workflowExecution?.runId,
          },
        },
      }),
    );
    expect(mock.span.log).toHaveBeenCalledWith({ output });
    expect(mock.span.end).toHaveBeenCalledOnce();
  });

  test("preserves activity errors and ends the span", async () => {
    const interceptor = createBraintrustActivityInterceptor(context).inbound!;
    const error = new Error("activity failed");
    const next = vi.fn().mockRejectedValue(error);

    await expect(
      interceptor.execute!({ args: [], headers: {} }, next),
    ).rejects.toBe(error);
    expect(next).toHaveBeenCalledOnce();
    expect(mock.span.log).toHaveBeenCalledWith({ error: String(error) });
    expect(mock.span.end).toHaveBeenCalledOnce();
  });
});
