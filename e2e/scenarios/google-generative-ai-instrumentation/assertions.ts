import { beforeAll, describe, expect, test } from "vitest";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import {
  effectiveScenarioTimeoutMs,
  withScenarioHarness,
} from "../../helpers/scenario-harness";
import { matchSpanTreeSnapshot, spanTreeFields } from "../../helpers/span-tree";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";
import { findLatestSpan, findAllSpans } from "../../helpers/trace-selectors";

const OPERATIONS = [
  "generation",
  "image",
  "stream",
  "response-only",
  "chat",
  "chat-stream",
  "tools",
  "embedding",
  "batch-embedding",
  "embedding-with-usage",
  "batch-embedding-with-usage",
  "error",
];

export function defineGoogleGenerativeAIInstrumentationAssertions(options: {
  name: string;
  runScenario: Parameters<typeof withScenarioHarness>[0];
  snapshotName: string;
  testFileUrl: string;
  timeoutMs: number;
}): void {
  const spanSnapshotPath = resolveFileSnapshotPath(
    options.testFileUrl,
    `${options.snapshotName}.span-tree.json`,
  );

  describe(options.name, () => {
    let events: CapturedLogEvent[] = [];
    let llms: CapturedLogEvent[] = [];

    beforeAll(async () => {
      await withScenarioHarness(async (harness) => {
        await options.runScenario(harness);
        events = harness.events();
        llms = [
          "generate_content",
          "embed_content",
          "batch_embed_contents",
        ].flatMap((name) => findAllSpans(events, name));
      });
    }, effectiveScenarioTimeoutMs(options.timeoutMs));

    test("captures one LLM span per operation", () => {
      expect(llms).toHaveLength(OPERATIONS.length);
    });

    test.each(OPERATIONS)("captures %s", (name) => {
      const operation = findLatestSpan(events, name);
      expect(operation).toBeDefined();
      const children = llms.filter((event) =>
        event.span.parentIds?.includes(operation!.span.id!),
      );
      expect(children).toHaveLength(1);
      expect(children[0].row.metadata).toMatchObject({
        provider: "google",
      });
      expect(children[0].context).toHaveProperty(
        "span_origin.instrumentation.name",
        "google-generative-ai",
      );
      expect(children[0].span.ended).toBe(true);
      if (name === "image")
        expect(children[0].input).toHaveProperty(
          "contents.1.parts.1.inlineData.data.type",
          "braintrust_attachment",
        );
      if (name === "error") expect(children[0].row.error).toBeTruthy();
      else if (!name.includes("embedding")) {
        expect(children[0].metrics?.prompt_tokens).toBeGreaterThan(0);
        expect(children[0].output).toHaveProperty("candidates");
      }
      if (name.startsWith("embedding")) {
        expect(children[0].output).toEqual({ count: 1 });
        expect(children[0].input).toEqual({
          inputs: [{ content: "Braintrust tracing" }],
          output_dimensions: 32,
        });
      }
      if (name.startsWith("batch-embedding"))
        expect(children[0].output).toEqual({ count: 2 });
      if (name.includes("embedding")) {
        expect(children[0].metrics).not.toHaveProperty("completion_tokens");
        if (name.endsWith("-with-usage")) {
          expect(children[0].metrics?.prompt_tokens).toBeGreaterThan(0);
          expect(children[0].metrics?.tokens).toBe(
            children[0].metrics?.prompt_tokens,
          );
          expect(children[0].row.metadata).toMatchObject({
            model: "gemini-embedding-2",
          });
        } else {
          expect(children[0].metrics).not.toHaveProperty("prompt_tokens");
          expect(children[0].metrics).not.toHaveProperty("tokens");
        }
      }
      if (name === "stream" || name === "chat-stream")
        expect(children[0].metrics?.time_to_first_token).toBeGreaterThanOrEqual(
          0,
        );
      if (name === "chat-stream")
        expect(children[0].input).toHaveProperty("contents.length", 6);
    });

    test("matches the span tree snapshot", async () => {
      await matchSpanTreeSnapshot(
        events.map((event) => ({
          event,
          fields: { ...spanTreeFields(event), context: event.context },
        })),
        spanSnapshotPath,
      );
    });
  });
}
