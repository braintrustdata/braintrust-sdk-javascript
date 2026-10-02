import { afterEach, describe, expect, it, vi } from "vitest";
import iso from "../isomorph";
import { _internalCaptureAttachmentsEnabled, Attachment } from "../logger";
import { processInputAttachments } from "./attachment-utils";

const originalGetEnv = iso.getEnv;

afterEach(() => {
  iso.getEnv = originalGetEnv;
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
