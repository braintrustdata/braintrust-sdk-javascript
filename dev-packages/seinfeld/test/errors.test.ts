import { describe, expect, it } from "vitest";
import type { RecordedRequest } from "../src/cassette";
import {
  CassetteFormatError,
  CassetteMissError,
  CassetteVersionError,
} from "../src/errors";

const sampleRequest: RecordedRequest = {
  method: "POST",
  url: "https://api.openai.com/v1/chat/completions",
  headers: { "content-type": "application/json" },
  body: { kind: "empty" },
};

describe("CassetteMissError", () => {
  it("captures the request, cassette name, and match key", () => {
    const err = new CassetteMissError({
      request: sampleRequest,
      cassetteName: "demo",
      matchKey: "POST api.openai.com/v1/chat/completions",
    });
    expect(err.name).toBe("CassetteMissError");
    expect(err.request).toBe(sampleRequest);
    expect(err.cassetteName).toBe("demo");
    expect(err.matchKey).toBe("POST api.openai.com/v1/chat/completions");
    expect(err.message).toContain("demo");
    expect(err.message).toContain("POST api.openai.com/v1/chat/completions");
    expect(err.message).toContain("mode='record'");
  });

  it("honors a custom error message", () => {
    const err = new CassetteMissError({
      request: sampleRequest,
      cassetteName: "demo",
      matchKey: "GET example.com/",
      message: "totally custom",
    });
    expect(err.message).toBe("totally custom");
  });

  it("is an instance of Error", () => {
    const err = new CassetteMissError({
      request: sampleRequest,
      cassetteName: "demo",
      matchKey: "GET example.com/",
    });
    expect(err).toBeInstanceOf(Error);
  });
});

describe("CassetteVersionError", () => {
  it("mentions both the found and supported versions", () => {
    const err = new CassetteVersionError({
      cassetteName: "demo",
      foundVersion: 99,
      supportedVersion: 1,
    });
    expect(err.message).toContain("99");
    expect(err.message).toContain("1");
    expect(err.message).toContain("Upgrade");
    expect(err.foundVersion).toBe(99);
    expect(err.supportedVersion).toBe(1);
  });
});

describe("CassetteFormatError", () => {
  it("includes the cassette name and inner message", () => {
    const err = new CassetteFormatError({
      cassetteName: "demo",
      message: "invalid: foo",
    });
    expect(err.message).toContain("demo");
    expect(err.message).toContain("invalid: foo");
    expect(err.cassetteName).toBe("demo");
  });
});
