import { expect } from "vitest";
import { createHarness, createJudge, describeEval } from "vitest-evals";

const testRunId = process.env.BRAINTRUST_E2E_RUN_ID;
if (!testRunId) {
  throw new Error("BRAINTRUST_E2E_RUN_ID is not set");
}

type RefundOutput = {
  message: string;
  status: "approved" | "denied";
};

const scenario = "test-framework-evals-vitest";

const refundHarness = createHarness<string, RefundOutput>({
  name: "braintrust-refund-harness",
  run: async ({ input }) => ({
    artifacts: {
      case: "vitest-evals-reporter",
      scenario,
      testRunId,
    },
    messages: [
      { role: "user", content: input },
      {
        role: "assistant",
        content: "Invoice inv_123 is refundable and the refund is approved.",
      },
    ],
    output: {
      message: "Invoice inv_123 is refundable and the refund is approved.",
      status: "approved",
    },
    toolCalls: [
      {
        name: "lookupInvoice",
        arguments: { invoiceId: "inv_123" },
        result: { refundable: true },
      },
    ],
    traces: [
      {
        id: "refund-trace",
        name: "refund trace",
        spans: [
          {
            id: "model-span",
            kind: "model",
            name: "classify refund",
            attributes: {
              "gen_ai.request.model": "deterministic-refund-model",
            },
          },
          {
            id: "tool-span",
            kind: "tool",
            name: "lookupInvoice",
            parentId: "model-span",
            attributes: {
              "gen_ai.tool.name": "lookupInvoice",
            },
          },
        ],
      },
    ],
    usage: {
      inputTokens: 11,
      outputTokens: 13,
      totalTokens: 24,
      toolCalls: 1,
    },
  }),
});

const StatusJudge = createJudge<
  string,
  RefundOutput,
  { expectedStatus: RefundOutput["status"] }
>("StatusJudge", async ({ output, expectedStatus }) => ({
  metadata: {
    expectedStatus,
    observedStatus: output.status,
  },
  score: output.status === expectedStatus ? 1 : 0,
}));

describeEval(
  "vitest-evals braintrust reporter",
  { harness: refundHarness },
  (it) => {
    it("approves refundable invoice", async ({ run }) => {
      const result = await run("Refund invoice inv_123");

      expect(result.output.status).toBe("approved");
      await expect(result).toSatisfyJudge(StatusJudge, {
        expectedStatus: "approved",
        threshold: 1,
      });
    });
  },
);
