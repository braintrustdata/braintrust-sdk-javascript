import { describe, expect, test, vi } from "vitest";
import {
  buildCompletionWebhookPayload,
  dispatchCompletionWebhook,
} from "./server";

const summary = {
  projectName: "completion-webhook-test",
  experimentName: "completion-webhook-test-exp",
  scores: {
    exact_match: {
      name: "exact_match",
      score: 1,
    },
  },
};

describe("completion webhook delivery", () => {
  test("builds expected payload shape", async () => {
    const payload = buildCompletionWebhookPayload(summary);

    expect(payload.event).toBe("experiment.completed");
    expect(payload.summary.projectName).toBe("completion-webhook-test");
    expect(payload.experiment.projectName).toBe("completion-webhook-test");
    expect(payload.timestamp).toMatch(/T/);
  });

  test("retries transient failures and succeeds", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(new Response("bad", { status: 500 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    await dispatchCompletionWebhook("https://example.com/webhook", summary, {
      fetchImpl,
      sleep,
      timeoutMs: 5,
      attempts: 3,
      backoffMs: [1, 2, 4],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  test("throws after final failure", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("bad", { status: 500 }));

    await expect(
      dispatchCompletionWebhook("https://example.com/webhook", summary, {
        fetchImpl,
        sleep,
        timeoutMs: 5,
        attempts: 3,
        backoffMs: [1, 2, 4],
      }),
    ).rejects.toThrow("status 500");

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
