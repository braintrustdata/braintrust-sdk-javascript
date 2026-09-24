import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { _exportsForTestingOnly, initLogger } from "braintrust";
import { OpenAIAgentsTraceProcessor } from "./index";
import type { AgentsSpan, AgentsTrace } from "./types";

let background: ReturnType<
  typeof _exportsForTestingOnly.useTestBackgroundLogger
>;
beforeAll(() => _exportsForTestingOnly.simulateLoginForTests());
beforeEach(() => {
  background = _exportsForTestingOnly.useTestBackgroundLogger();
});
afterEach(() => {
  _exportsForTestingOnly.clearTestBackgroundLogger();
  vi.unstubAllEnvs();
});

it.each([true, false])(
  "uses its local logger policy (%s) when trace events arrive outside the original context",
  async (captureAttachments) => {
    vi.stubEnv("BRAINTRUST_CAPTURE_ATTACHMENTS", String(!captureAttachments));
    const options = {
      projectId: "test-project-id",
      projectName: "tmp-luca-agents-capture",
    };
    const logger = initLogger({
      ...options,
      captureAttachments,
      setCurrent: false,
    });
    const processor = new OpenAIAgentsTraceProcessor({ logger });
    const trace: AgentsTrace = {
      type: "trace",
      traceId: "trace",
      name: "test trace",
      groupId: null,
    };
    const span: AgentsSpan = {
      type: "trace.span",
      traceId: "trace",
      spanId: "response",
      parentId: null,
      startedAt: null,
      endedAt: null,
      error: null,
      spanData: {
        type: "response",
        _input: [{ type: "input_image", image: "data:image/png;base64,AQID" }],
        _response: {
          output: [{ type: "image_generation_call", result: "AQID" }],
        },
      },
    };
    await processor.onTraceStart(trace);
    await processor.onSpanStart(span);
    initLogger({ ...options, captureAttachments: !captureAttachments });
    await processor.onSpanEnd(span);
    await processor.onTraceEnd(trace);
    const payload = JSON.stringify(await background.drain());
    if (captureAttachments) expect(payload).toContain("braintrust_attachment");
    else {
      expect(payload).not.toContain("input_image");
      expect(payload).not.toContain("image_generation_call");
      expect(payload).not.toContain("AQID");
      expect(payload).not.toContain("braintrust_attachment");
    }
  },
);
