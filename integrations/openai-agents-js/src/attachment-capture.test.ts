import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { Attachment, _exportsForTestingOnly, initLogger } from "braintrust";
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
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([true, false])(
  "uses the owning audio policy (%s) for child and root spans",
  async (captureAttachments) => {
    const options = {
      projectId: "test-project-id",
      projectName: "tmp-luca-agents-audio-capture",
    };
    const logger = initLogger({
      ...options,
      captureAttachments,
      setCurrent: false,
    });
    const processor = new OpenAIAgentsTraceProcessor({ logger });
    const decode = vi.spyOn(globalThis, "atob");
    for (const type of ["transcription", "speech"] as const) {
      const trace: AgentsTrace = {
        type: "trace",
        traceId: type,
        name: type,
        groupId: null,
      };
      const readData = vi.fn(() => "AQID");
      const audio = {
        get data() {
          return readData();
        },
        format: "pcm",
      };
      const span: AgentsSpan = {
        type: "trace.span",
        traceId: type,
        spanId: `${type}-span`,
        parentId: null,
        startedAt: null,
        endedAt: null,
        error: null,
        spanData:
          type === "speech"
            ? { type, input: "Hello", output: audio }
            : { type, input: audio, output: "Hello" },
      };
      await processor.onTraceStart(trace);
      await processor.onSpanStart(span);
      initLogger({ ...options, captureAttachments: !captureAttachments });
      await processor.onSpanEnd(span);
      const metadata = processor._traceSpans.get(type)?.metadata;
      const expected = {
        format: "pcm",
        ...(captureAttachments ? { data: expect.any(Attachment) } : {}),
      };
      expect(
        type === "speech" ? metadata?.lastOutput : metadata?.firstInput,
      ).toEqual(expected);
      await processor.onTraceEnd(trace);
      const rows = await background.drain();
      const field = type === "speech" ? "output" : "input";
      const audioRows = rows.filter((row) => {
        const value = row[field as keyof typeof row];
        return value && typeof value === "object" && "format" in value;
      });
      expect(audioRows).toHaveLength(2);
      for (const row of audioRows) expect(row).toHaveProperty(field, expected);
      expect(
        rows.some((row) =>
          type === "speech"
            ? "input" in row && row.input === "Hello"
            : "output" in row && row.output === "Hello",
        ),
      ).toBe(true);
      if (!captureAttachments) {
        expect(readData).not.toHaveBeenCalled();
        expect(decode).not.toHaveBeenCalled();
        expect(JSON.stringify(rows)).not.toContain("AQID");
      }
    }
  },
);

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
        _input: [
          { type: "input_image", image: "data:image/png;base64,AQID" },
          { type: "input_file", file: "data:application/pdf;base64,AQID" },
          { type: "input_file", file: "https://example.com/report.pdf" },
          { type: "input_file", file: { id: "file-123" } },
          {
            type: "input_file",
            file: { url: "https://example.com/report.pdf" },
          },
        ],
        _response: {
          output: [{ type: "image_generation_call", result: "AQID" }],
        },
      },
    };
    await processor.onTraceStart(trace);
    await processor.onSpanStart(span);
    initLogger({ ...options, captureAttachments: !captureAttachments });
    await processor.onSpanEnd(span);
    const expectedInput = [
      ...(captureAttachments
        ? [
            { type: "input_image", image: expect.any(Attachment) },
            { type: "input_file", file: expect.any(Attachment) },
          ]
        : []),
      { type: "input_file", file: "https://example.com/report.pdf" },
      { type: "input_file", file: { id: "file-123" } },
      { type: "input_file", file: { url: "https://example.com/report.pdf" } },
    ];
    expect(
      processor._traceSpans.get(trace.traceId)?.metadata.firstInput,
    ).toEqual(expectedInput);
    await processor.onTraceEnd(trace);
    const rows = await background.drain();
    for (const row of rows.filter((row) => "input" in row))
      expect(row).toHaveProperty("input", expectedInput);
    const payload = JSON.stringify(rows);
    if (captureAttachments) expect(payload).toContain("braintrust_attachment");
    else {
      expect(payload).not.toContain("input_image");
      expect(payload).not.toContain("image_generation_call");
      expect(payload).not.toContain("AQID");
      expect(payload).not.toContain("braintrust_attachment");
    }
  },
);

it.each([false, true])(
  "applies capture=%s to native Chat Completions generation inputs",
  async (captureAttachments) => {
    const options = {
      projectId: "test-project-id",
      projectName: "tmp-luca-agents-chat-capture",
    };
    const logger = initLogger({
      ...options,
      captureAttachments,
      setCurrent: false,
    });
    const processor = new OpenAIAgentsTraceProcessor({ logger });
    const trace: AgentsTrace = {
      type: "trace",
      traceId: "chat-input",
      name: "chat input",
      groupId: null,
    };
    const content = [
      { type: "text", text: "Describe this media." },
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,AQID", detail: "low" },
      },
      { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } },
      { type: "input_audio", input_audio: { data: "AQID", format: "mp3" } },
      { type: "file", file: { file_data: "AQID", filename: "document.pdf" } },
      {
        type: "image_url",
        image_url: { url: "https://example.com/image.png" },
      },
      { type: "file", file: { file_id: "file-123" } },
    ];
    const originalContent = structuredClone(content);
    const span: AgentsSpan = {
      type: "trace.span",
      traceId: trace.traceId,
      spanId: "generation",
      parentId: null,
      startedAt: null,
      endedAt: null,
      error: null,
      spanData: {
        type: "generation",
        input: [{ role: "user", content }],
      },
    };
    await processor.onTraceStart(trace);
    await processor.onSpanStart(span);
    initLogger({ ...options, captureAttachments: !captureAttachments });
    await processor.onSpanEnd(span);
    await processor.onTraceEnd(trace);
    const rows = await background.drain();
    const inputRows = rows.filter((row) => "input" in row);
    expect(inputRows).toHaveLength(2);
    for (const row of inputRows) {
      expect(row).toHaveProperty("input.0.content", [
        content[0],
        {
          type: "image_url",
          image_url: {
            detail: "low",
            ...(captureAttachments ? { url: expect.any(Attachment) } : {}),
          },
        },
        ...(captureAttachments
          ? [{ type: "image_url", image_url: { url: expect.any(Attachment) } }]
          : []),
        {
          type: "input_audio",
          input_audio: {
            format: "mp3",
            ...(captureAttachments ? { data: expect.any(Attachment) } : {}),
          },
        },
        {
          type: "file",
          file: {
            filename: "document.pdf",
            ...(captureAttachments
              ? { file_data: expect.any(Attachment) }
              : {}),
          },
        },
        ...content.slice(5),
      ]);
    }
    expect(content).toEqual(originalContent);
    expect(JSON.stringify(inputRows)).not.toContain("AQID");
  },
);

it.each([false, true])(
  "captures generation and protocol audio with the owning policy (%s)",
  async (captureAttachments) => {
    const options = {
      projectId: "test-project-id",
      projectName: "tmp-luca-agents-audio-output",
    };
    const logger = initLogger({
      ...options,
      captureAttachments,
      setCurrent: false,
    });
    const processor = new OpenAIAgentsTraceProcessor({ logger });
    const trace: AgentsTrace = {
      type: "trace",
      traceId: "audio-output",
      name: "audio output",
      groupId: null,
    };
    const audio = {
      data: "AQID",
      transcript: "Hello",
      id: "audio-1",
      expires_at: 123,
    };
    const output = [{ choices: [{ message: { role: "assistant", audio } }] }];
    const span: AgentsSpan = {
      type: "trace.span",
      traceId: trace.traceId,
      spanId: "generation",
      parentId: null,
      startedAt: null,
      endedAt: null,
      error: null,
      spanData: {
        type: "generation",
        output,
        input: [
          {
            role: "user",
            content: [
              {
                type: "audio",
                audio: "AQID",
                format: "mp3",
                transcript: "Hello",
              },
              { type: "audio", audio: { id: "file-123" } },
            ],
          },
        ],
      },
    };
    await processor.onTraceStart(trace);
    await processor.onSpanStart(span);
    initLogger({ ...options, captureAttachments: !captureAttachments });
    await processor.onSpanEnd(span);
    const rows = await background.drain();
    const row = rows.find((row) => "output" in row && row.output !== undefined);
    expect(row).toHaveProperty("output.0.choices.0.message.audio", {
      transcript: "Hello",
      id: "audio-1",
      expires_at: 123,
      ...(captureAttachments ? { data: expect.any(Attachment) } : {}),
    });
    expect(row).toHaveProperty("input.0.content", [
      {
        type: "audio",
        format: "mp3",
        transcript: "Hello",
        ...(captureAttachments ? { audio: expect.any(Attachment) } : {}),
      },
      { type: "audio", audio: { id: "file-123" } },
    ]);
    expect(audio.data).toBe("AQID");
  },
);
