import { afterEach, describe, expect, it } from "vitest";
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
      image_url: { detail: "low", url: "<omitted>" },
    },
    {
      type: "image_url",
      image_url: { url: "https://example.com/image.png" },
    },
    {
      type: "file",
      file: { filename: "document.pdf", file_data: "<omitted>" },
    },
  ]);
});
