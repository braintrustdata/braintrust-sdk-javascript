import { afterEach, describe, expect, it, vi } from "vitest";
import iso from "../isomorph";
import {
  isAutoCaptureAttachmentsEnabled,
  processInputAttachments,
} from "./attachment-utils";

const originalGetEnv = iso.getEnv;

afterEach(() => {
  iso.getEnv = originalGetEnv;
});

describe("isAutoCaptureAttachmentsEnabled", () => {
  it.each(["1", "true", " TRUE "])('accepts "%s"', (value) => {
    iso.getEnv = () => value;

    expect(isAutoCaptureAttachmentsEnabled()).toBe(true);
  });

  it.each([undefined, "0", "false", "yes", "on", "unexpected"])(
    'rejects "%s"',
    (value) => {
      iso.getEnv = () => value;

      expect(isAutoCaptureAttachmentsEnabled()).toBe(false);
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
