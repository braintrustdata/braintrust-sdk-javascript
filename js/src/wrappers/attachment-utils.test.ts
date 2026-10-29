import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import iso from "#braintrust-platform";
import { Attachment, BaseAttachment } from "../logger/core";
import { _exportsForTestingOnly } from "../logger/testing";
import { processInputAttachments } from "./attachment-utils";
import { _internalCaptureAttachmentsEnabled } from "../logger/core";

const originalGetEnv = iso.getEnv;

afterEach(() => {
  iso.getEnv = originalGetEnv;
  vi.unstubAllGlobals();
});

describe("_internalCaptureAttachmentsEnabled", () => {
  it.each(["1", "true", " TRUE "])('accepts "%s"', (value) => {
    iso.getEnv = () => value;

    expect(_internalCaptureAttachmentsEnabled()).toBe(true);
  });

  it.each([undefined, "0", "false", "yes", "on", "unexpected"])(
    'rejects "%s"',
    (value) => {
      iso.getEnv = () => value;

      expect(_internalCaptureAttachmentsEnabled()).toBe(false);
    },
  );
});

it("omits inline attachment data while preserving remote references", () => {
  const input = [
    {
      type: "image_url",
      image_url: { detail: "low", url: "data:image/png;base64,AQID" },
    },
    {
      type: "image_url",
      image_url: { url: "https://example.com/image.png" },
    },
    {
      type: "file",
      file: {
        filename: "document.pdf",
        file_data: "data:application/pdf;base64,AQID",
      },
    },
  ];

  expect(processInputAttachments(input, false)).toEqual([
    {
      type: "image_url",
      image_url: { detail: "low" },
    },
    {
      type: "image_url",
      image_url: { url: "https://example.com/image.png" },
    },
    {
      type: "file",
      file: { filename: "document.pdf" },
    },
  ]);
});

it("skips data URL parsing for disabled media across supported input formats", () => {
  const data = "data:application/octet-stream;base64,AQID";
  const input = [
    { type: "image_url", image_url: { url: data } },
    { type: "image_base64", imageBase64: data },
    { type: "video_base64", video_base64: data },
    { type: "file", file: { file_data: data } },
    { type: "image", image: data },
    { type: "file", data, mediaType: "application/pdf" },
  ];
  const parse = vi.spyOn(String.prototype, "match");
  let output;
  let parseCalls;
  try {
    output = processInputAttachments(input, false);
    parseCalls = parse.mock.calls.length;
  } finally {
    parse.mockRestore();
  }
  expect(parseCalls).toBe(0);
  expect(output).toEqual([{ type: "file", mediaType: "application/pdf" }]);
  expect(JSON.stringify(output)).not.toContain("AQID");
  expect(input[0].image_url?.url).toBe(data);
});

it.each([false, true])(
  "applies capture=%s to data URL objects while preserving remote URLs",
  (captureAttachments) => {
    const data = new URL("data:image/png;base64,AQID");
    const remote = new URL("https://example.com/image.png");
    const input = [
      data,
      { type: "image", image: data },
      { type: "file", data, mediaType: "image/png" },
      { type: "image_url", image_url: { url: data, detail: "low" } },
      { type: "file", file: { file_data: data, filename: "image.png" } },
      remote,
      { type: "image", image: remote },
      { type: "file", data: remote, mediaType: "image/png" },
    ];
    const decode = vi.spyOn(globalThis, "atob");
    try {
      const output = processInputAttachments(input, captureAttachments);
      if (captureAttachments) {
        expect(output.slice(0, 5)).toEqual([
          expect.any(Attachment),
          { type: "image", image: expect.any(Attachment) },
          {
            type: "file",
            data: expect.any(Attachment),
            mediaType: "image/png",
          },
          {
            type: "image_url",
            image_url: { url: expect.any(Attachment), detail: "low" },
          },
          {
            type: "file",
            file: { file_data: expect.any(Attachment), filename: "image.png" },
          },
        ]);
      } else {
        expect(decode).not.toHaveBeenCalled();
        expect(output.slice(0, -3)).toEqual([
          { type: "file", mediaType: "image/png" },
          { type: "image_url", image_url: { detail: "low" } },
          { type: "file", file: { filename: "image.png" } },
        ]);
      }
      expect(output.slice(-3)).toEqual(input.slice(-3));
      expect(JSON.stringify(output)).not.toContain("AQID");
      expect(data.href).toBe("data:image/png;base64,AQID");
    } finally {
      decode.mockRestore();
    }
  },
);
it("captures OpenAI input images only when enabled and preserves their detail", () => {
  const input = [
    {
      role: "user",
      content: [
        {
          type: "input_image",
          image_url:
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==",
          detail: "low",
        },
      ],
    },
  ];
  expect(processInputAttachments(input, false)[0].content[0]).toEqual({
    type: "input_image",
    detail: "low",
  });
  expect(processInputAttachments(input, true)[0].content[0]).toEqual({
    type: "input_image",
    image_url: expect.any(Attachment),
    detail: "low",
  });
  expect(input[0].content[0].image_url).toMatch(/^data:/);
});

const image =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

it("preserves nesting, siblings, order, references and malformed media", async () => {
  const references = [
    {
      type: "braintrust_attachment",
      key: "existing",
      filename: "a.png",
      content_type: "image/png",
    },
    { type: "external_attachment", url: "https://example.com/image.png" },
    { type: "inline_attachment", src: image },
  ];
  const input = {
    state: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "before" },
          { type: "input_image", image_url: image, detail: "low" },
          ...references.map((ref) => ({ type: "input_image", image_url: ref })),
          { type: "input_image", image_url: "https://example.com/image.png" },
          { type: "input_image", image_url: "data:image/png;base64,%%%" },
          { type: "input_image", image_url: "data:;base64,AQID" },
          { type: "input_image", image_url: "data:image/unknown;base64,AQID" },
          { type: "input_image", image_url: image, detail: "high" },
          { type: "input_text", text: "after" },
        ],
      },
    ],
    questions: [{ id: "one", instructions: "Inspect images", type: "boolean" }],
  };
  const original = structuredClone(input);
  const processed = processInputAttachments(input, true);
  expect(processed.state[0].content.slice(2, 9)).toEqual(
    input.state[0].content.slice(2, 9),
  );
  expect(processed.questions).toEqual(input.questions);
  const uploads: BaseAttachment[] = [];
  _exportsForTestingOnly.extractAttachments(processed, uploads);
  expect(uploads).toHaveLength(2);
  expect(processed.state[0].content[1]).toEqual({
    type: "input_image",
    detail: "low",
    image_url: uploads[0].reference,
  });
  expect(processed.state[0].content[9]).toEqual({
    type: "input_image",
    detail: "high",
    image_url: uploads[1].reference,
  });
  expect(await (await uploads[0].data()).arrayBuffer()).toEqual(
    await (await uploads[1].data()).arrayBuffer(),
  );
  expect(input).toEqual(original);
  expect(processInputAttachments(references, false)).toEqual(references);
});

it("aborts the whole conversion if attachment construction throws", () => {
  const input = [
    { type: "input_image", image_url: image },
    { type: "input_image", image_url: image },
  ];
  let conversions = 0;
  const OriginalBlob = Blob;
  vi.stubGlobal(
    "Blob",
    class extends OriginalBlob {
      constructor(parts: BlobPart[], options: BlobPropertyBag) {
        if (++conversions === 2) throw new Error("conversion failed");
        super(parts, options);
      }
    },
  );
  expect(processInputAttachments(input, true)).toBe(input);
});

it("rolls back every replacement and queued upload when enqueue fails", () => {
  const input = {
    state: [
      { type: "input_image", image_url: image },
      { type: "input_image", image_url: image },
    ],
  };
  const processed = processInputAttachments(input, true);
  const uploads: BaseAttachment[] = [];
  const push = vi.spyOn(uploads, "push");
  push.mockImplementationOnce((...items) =>
    Array.prototype.push.apply(uploads, items),
  );
  push.mockImplementationOnce(() => {
    throw new Error("queue full");
  });
  _exportsForTestingOnly.extractAttachments(processed, uploads);
  expect(uploads).toHaveLength(0);
  expect(processed).toEqual(input);
});
