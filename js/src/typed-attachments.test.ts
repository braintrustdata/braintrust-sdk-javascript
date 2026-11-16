import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vite-plus/test";
import { Attachment } from "./logger/core";
import { configureNode } from "./node/config";
import {
  TypedAttachmentProcessor,
  prepareTypedAttachments,
} from "./typed-attachments";
import * as attachmentUtils from "./wrappers/attachment-utils";

configureNode();
// A valid 32x32 PNG, also used to verify the uploaded bytes rather than only keys.
const png =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NsQ0AAAzCMP5/un0CNkuZ41wybXsHAAAAAAAAAAAAxR4yw/wuPL6QkAAAAABJRU5ErkJggg==";
const image = `data:image/png;base64,${png}`;
const file = {
  type: "file",
  mediaType: "image/png",
  filename: "pixel.png",
  data: png,
};

beforeEach(() => vi.stubEnv("BRAINTRUST_AUTO_CAPTURE_ATTACHMENTS", "true"));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("decision attachment export", () => {
  test("preserves envelopes, nesting, siblings, order, and associations across input and output", async () => {
    const uploaded: Attachment[] = [];
    vi.spyOn(Attachment.prototype, "upload").mockImplementation(async function (
      this: Attachment,
    ) {
      uploaded.push(this);
      return { upload_status: "done" };
    });
    const record = {
      input: {
        state: [
          { type: "text", text: "Inspect" },
          file,
          { type: "json", value: { nested: ["keep", { picture: image }] } },
          { ...file, filename: "second.png" },
        ],
        questions: [
          {
            id: "quality",
            type: "score",
            instructions: { examples: [image] },
            criteria: [{ label: "bad", image }, "good"],
          },
        ],
      },
      output: {
        answers: [
          {
            id: "quality",
            type: "score",
            score: 1,
            legend: { 0: { image }, 1: "good" },
          },
        ],
      },
    };
    const original = structuredClone(record);
    const result = await new TypedAttachmentProcessor().process(record);
    const ref = {
      type: "braintrust_attachment",
      content_type: "image/png",
      filename: "attachment.png",
      key: expect.any(String),
    };
    expect(result).toEqual({
      input: {
        state: [
          { type: "text", text: "Inspect" },
          { ...file, data: { ...ref, filename: "pixel.png" } },
          { type: "json", value: { nested: ["keep", { picture: ref }] } },
          {
            ...file,
            filename: "second.png",
            data: { ...ref, filename: "second.png" },
          },
        ],
        questions: [
          {
            id: "quality",
            type: "score",
            instructions: { examples: [ref] },
            criteria: [{ label: "bad", image: ref }, "good"],
          },
        ],
      },
      output: {
        answers: [
          {
            id: "quality",
            type: "score",
            score: 1,
            legend: { 0: { image: ref }, 1: "good" },
          },
        ],
      },
    });
    expect(record).toEqual(original);
    expect(uploaded).toHaveLength(6);
    for (const attachment of uploaded) {
      expect(
        Buffer.from(await (await attachment.data()).arrayBuffer()).toString(
          "base64",
        ),
      ).toBe(png);
    }
  });

  test("preserves references, remote URLs, unknown MIME and undecodable values", async () => {
    const upload = vi.spyOn(Attachment.prototype, "upload");
    const references = [
      {
        type: "braintrust_attachment",
        key: "existing",
        filename: "a.png",
        content_type: "image/png",
      },
      {
        type: "external_attachment",
        url: "https://example.com/a.png",
        content_type: "image/png",
      },
      { type: "inline_attachment", content_type: "image/png", data: png },
    ];
    const state = [
      ...references.map((data) => ({ ...file, data })),
      { ...file, data: "https://example.com/a.png" },
      { ...file, mediaType: "unknown", data: png },
      { type: "file", data: png },
      { ...file, data: "data:;base64,AAAA" },
    ];
    const record = { input: { state, questions: [] } };
    expect(await new TypedAttachmentProcessor().process(record)).toEqual(
      record,
    );
    expect(upload).not.toHaveBeenCalled();
    const malformed = {
      input: {
        state: [file, { ...file, data: "%%%invalid%%%" }],
        questions: [],
      },
    };
    expect(await new TypedAttachmentProcessor().process(malformed)).toBe(
      malformed,
    );
    expect(upload).not.toHaveBeenCalled();
  });

  test.each(["application/octet-stream", "application/vnd.example+binary"])(
    "captures declared %s even without a known filename extension",
    async (mediaType) => {
      const upload = vi
        .spyOn(Attachment.prototype, "upload")
        .mockResolvedValue({ upload_status: "done" });
      const record = {
        input: {
          state: [
            { ...file, mediaType, filename: "payload.dat" },
            { type: "file", mediaType, data: png },
          ],
          questions: [],
        },
      };
      const result = await new TypedAttachmentProcessor().process(record);
      expect(result.input.state).toEqual([
        {
          ...file,
          mediaType,
          filename: "payload.dat",
          data: {
            type: "braintrust_attachment",
            content_type: mediaType,
            filename: "payload.dat",
            key: expect.any(String),
          },
        },
        {
          type: "file",
          mediaType,
          data: {
            type: "braintrust_attachment",
            content_type: mediaType,
            filename: "attachment.bin",
            key: expect.any(String),
          },
        },
      ]);
      expect(upload).toHaveBeenCalledTimes(2);
      expect(record.input.state[0].data).toBe(png);
    },
  );

  test.each([127, 128, 129, 140])(
    "capture disabled does not leak media at depth %s",
    (depth) => {
      vi.stubEnv("BRAINTRUST_AUTO_CAPTURE_ATTACHMENTS", "false");
      let nested: unknown = { ...file, data: { type: "data", data: png } };
      for (let i = 0; i < depth; i++) nested = i % 2 ? { nested } : [nested];
      const input = {
        state: nested,
        questions: [
          {
            id: "q",
            type: "score",
            instructions: nested,
            criteria: [nested, "text"],
          },
        ],
      };
      const output = {
        answers: [{ id: "q", type: "score", score: 0, legend: { 0: nested } }],
      };
      const before = JSON.stringify({ input, output });
      const logged = JSON.stringify({
        input: prepareTypedAttachments(input),
        output: prepareTypedAttachments(output),
      });
      expect(logged).not.toContain(png);
      expect(logged).toContain("<omitted>");
      expect(logged).toContain('"id":"q"');
      expect(JSON.stringify({ input, output })).toBe(before);
    },
  );

  test.each(["conversion", "enqueue"])(
    "%s failure aborts all replacements before any upload",
    async (failure) => {
      const upload = vi.spyOn(Attachment.prototype, "upload");
      const record = {
        input: { state: [file, file], questions: [] },
        output: { answers: [{ id: "q", legend: { image } }] },
      };
      const push = Array.prototype.push;
      if (failure === "conversion") {
        const convert = attachmentUtils.convertDataToBlob;
        vi.spyOn(attachmentUtils, "convertDataToBlob")
          .mockImplementationOnce(convert)
          .mockImplementationOnce(() => {
            throw new Error("injected conversion failure");
          });
      } else {
        let enqueues = 0;
        Array.prototype.push = function (...items) {
          if (items[0] instanceof Attachment && ++enqueues === 2)
            throw new Error("injected enqueue failure");
          return push.apply(this, items);
        };
      }
      let result;
      try {
        result = await new TypedAttachmentProcessor().process(record);
      } finally {
        Array.prototype.push = push;
      }
      expect(result).toBe(record);
      expect(upload).not.toHaveBeenCalled();
    },
  );

  test.each(["throw", "error status"])(
    "upload %s retains original input/output and disables subsequent uploads",
    async (failure) => {
      const upload = vi
        .spyOn(Attachment.prototype, "upload")
        .mockResolvedValueOnce({ upload_status: "done" });
      if (failure === "throw")
        upload.mockRejectedValueOnce(new Error("injected failure"));
      else
        upload.mockResolvedValueOnce({
          upload_status: "error",
          error_message: "injected failure",
        });
      const record = {
        input: { state: [file, file], questions: [] },
        output: { answers: [{ id: "q", legend: { image } }] },
      };
      const processor = new TypedAttachmentProcessor();
      expect(await processor.process(record)).toBe(record);
      expect(await processor.process(record)).toBe(record);
      expect(upload).toHaveBeenCalledTimes(2);
    },
  );

  test("capture disabled omits bytes recursively but preserves explicit references and URLs", async () => {
    vi.stubEnv("BRAINTRUST_AUTO_CAPTURE_ATTACHMENTS", "false");
    const upload = vi.spyOn(Attachment.prototype, "upload");
    const reference = {
      type: "inline_attachment",
      content_type: "image/png",
      data: png,
    };
    const original = {
      state: [
        file,
        { ...file, data: reference },
        { ...file, data: new URL("https://example.com/a.png") },
      ],
      questions: [{ id: "q", instructions: { image }, criteria: [image] }],
    };
    const prepared = prepareTypedAttachments(original);
    expect(prepared).toEqual({
      state: [
        { ...file, data: "<omitted>" },
        { ...file, data: reference },
        { ...file, data: "https://example.com/a.png" },
      ],
      questions: [
        {
          id: "q",
          instructions: { image: "<omitted>" },
          criteria: ["<omitted>"],
        },
      ],
    });
    expect(
      await new TypedAttachmentProcessor().process({ input: prepared }),
    ).toEqual({ input: prepared });
    expect(upload).not.toHaveBeenCalled();
    expect(original.state[0]).toBe(file);
  });

  test("never rewrites question IDs or selected choice keys that resemble media", async () => {
    const upload = vi
      .spyOn(Attachment.prototype, "upload")
      .mockResolvedValue({ upload_status: "done" });
    const record = {
      input: {
        state: "choose",
        questions: [
          {
            id: image,
            type: "choice",
            instructions: "choose",
            criteria: { [image]: "this choice" },
          },
        ],
      },
      output: {
        answers: [
          {
            id: image,
            type: "choice",
            choice: image,
            probabilities: { [image]: 1 },
          },
        ],
      },
    };
    expect(await new TypedAttachmentProcessor().process(record)).toEqual(
      record,
    );
    vi.stubEnv("BRAINTRUST_AUTO_CAPTURE_ATTACHMENTS", "false");
    expect(prepareTypedAttachments(record.input)).toEqual(record.input);
    expect(prepareTypedAttachments(record.output)).toEqual(record.output);
    expect(upload).not.toHaveBeenCalled();
  });

  test("leaves embedded data URLs in ordinary text intact", async () => {
    const record = {
      input: {
        state: `${image} is the example, keep this text.`,
        questions: [],
      },
    };
    const upload = vi.spyOn(Attachment.prototype, "upload");
    expect(await new TypedAttachmentProcessor().process(record)).toEqual(
      record,
    );
    vi.stubEnv("BRAINTRUST_AUTO_CAPTURE_ATTACHMENTS", "false");
    expect(prepareTypedAttachments(record.input)).toEqual(record.input);
    expect(upload).not.toHaveBeenCalled();
  });

  test("snapshots only the byte view and preserves text-only payloads", () => {
    const bytes = new Uint8Array([9, 1, 2, 9]);
    const prepared = prepareTypedAttachments({
      state: [{ ...file, data: bytes.subarray(1, 3) }],
      questions: [],
    });
    bytes.fill(0);
    expect(prepared).toEqual({
      state: [{ ...file, data: "AQI=" }],
      questions: [],
    });
    const text = {
      state: "text",
      questions: [
        { id: "q", instructions: "a question", criteria: ["yes", "no"] },
      ],
    };
    expect(prepareTypedAttachments(text)).toEqual(text);
  });
});
