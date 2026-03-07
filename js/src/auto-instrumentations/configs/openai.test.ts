import { describe, it, expect } from "vitest";
import { openaiConfigs } from "./openai";

describe("OpenAI Instrumentation Configs", () => {
  function configsForChannel(channelName: string) {
    return openaiConfigs.filter((config) => config.channelName === channelName);
  }

  it("should have valid configs", () => {
    expect(openaiConfigs).toBeDefined();
    expect(Array.isArray(openaiConfigs)).toBe(true);
    expect(openaiConfigs.length).toBeGreaterThan(0);
  });

  it("should have chat.completions.create config", () => {
    const configs = configsForChannel("chat.completions.create");

    expect(configs).toHaveLength(3);
    expect(configs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          module: expect.objectContaining({
            name: "openai",
            versionRange: ">=4.0.0 <5.0.0",
            filePath: "resources/chat/completions.mjs",
          }),
          functionQuery: expect.objectContaining({
            className: "Completions",
            methodName: "create",
            kind: "Async",
          }),
        }),
        expect.objectContaining({
          module: expect.objectContaining({
            name: "openai",
            versionRange: ">=4.0.0 <5.0.0",
            filePath: "resources/chat/completions/completions.mjs",
          }),
          functionQuery: expect.objectContaining({
            className: "Completions",
            methodName: "create",
            kind: "Async",
          }),
        }),
        expect.objectContaining({
          module: expect.objectContaining({
            name: "openai",
            versionRange: ">=5.0.0",
            filePath: "resources/chat/completions/completions.mjs",
          }),
          functionQuery: expect.objectContaining({
            className: "Completions",
            methodName: "create",
            kind: "Async",
          }),
        }),
      ]),
    );
  });

  it("should have embeddings.create config", () => {
    const config = openaiConfigs.find(
      (c) => c.channelName === "embeddings.create",
    );

    expect(config).toBeDefined();
    expect(config?.module.name).toBe("openai");
    expect((config?.functionQuery as any).className).toBe("Embeddings");
    expect((config?.functionQuery as any).methodName).toBe("create");
    expect((config?.functionQuery as any).kind).toBe("Async");
  });

  it("should have moderations.create config", () => {
    const config = openaiConfigs.find(
      (c) => c.channelName === "moderations.create",
    );

    expect(config).toBeDefined();
    expect(config?.module.name).toBe("openai");
    expect((config?.functionQuery as any).className).toBe("Moderations");
    expect((config?.functionQuery as any).methodName).toBe("create");
    expect((config?.functionQuery as any).kind).toBe("Async");
  });

  it("should have beta.chat.completions.parse config", () => {
    const configs = configsForChannel("beta.chat.completions.parse");

    expect(configs).toHaveLength(2);
    expect(configs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          module: expect.objectContaining({
            name: "openai",
            versionRange: ">=4.0.0 <5.0.0",
            filePath: "resources/beta/chat/completions.mjs",
          }),
          functionQuery: expect.objectContaining({
            className: "Completions",
            methodName: "parse",
            kind: "Async",
          }),
        }),
        expect.objectContaining({
          module: expect.objectContaining({
            name: "openai",
            versionRange: ">=5.0.0",
            filePath: "resources/chat/completions/completions.mjs",
          }),
          functionQuery: expect.objectContaining({
            className: "Completions",
            methodName: "parse",
            kind: "Async",
          }),
        }),
      ]),
    );
  });

  it("should NOT include braintrust: prefix (code-transformer adds orchestrion:openai: prefix)", () => {
    for (const config of openaiConfigs) {
      expect(config.channelName).not.toContain("braintrust:");
      expect(config.channelName).not.toContain("orchestrion:");
    }
  });

  it("should target openai package for all configs", () => {
    for (const config of openaiConfigs) {
      expect(config.module.name).toBe("openai");
    }
  });

  it("should have valid version ranges", () => {
    for (const config of openaiConfigs) {
      expect(config.module.versionRange).toMatch(
        /^>=\d+\.\d+\.\d+( <\d+\.\d+\.\d+)?$/,
      );
    }
  });

  it("should have valid function kinds", () => {
    const validKinds = ["Async", "Sync", "Callback"];
    for (const config of openaiConfigs) {
      expect(validKinds).toContain((config.functionQuery as any).kind);
    }
  });

  it("should have beta.chat.completions.stream config with Sync kind", () => {
    const configs = configsForChannel("beta.chat.completions.stream");

    expect(configs).toHaveLength(2);
    expect(configs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          module: expect.objectContaining({
            name: "openai",
            versionRange: ">=4.0.0 <5.0.0",
            filePath: "resources/beta/chat/completions.mjs",
          }),
          functionQuery: expect.objectContaining({
            className: "Completions",
            methodName: "stream",
            kind: "Sync",
          }),
        }),
        expect.objectContaining({
          module: expect.objectContaining({
            name: "openai",
            versionRange: ">=5.0.0",
            filePath: "resources/chat/completions/completions.mjs",
          }),
          functionQuery: expect.objectContaining({
            className: "Completions",
            methodName: "stream",
            kind: "Sync",
          }),
        }),
      ]),
    );
  });

  it("should have responses.create config with version >=4.87.0", () => {
    const config = openaiConfigs.find(
      (c) => c.channelName === "responses.create",
    );

    expect(config).toBeDefined();
    expect(config?.module.name).toBe("openai");
    expect(config?.module.versionRange).toBe(">=4.87.0");
    expect(config?.module.filePath).toBe("resources/responses/responses.mjs");
    expect((config?.functionQuery as any).className).toBe("Responses");
    expect((config?.functionQuery as any).methodName).toBe("create");
    expect((config?.functionQuery as any).kind).toBe("Async");
  });

  it("should have responses.stream config with Sync kind and version >=4.87.0", () => {
    const config = openaiConfigs.find(
      (c) => c.channelName === "responses.stream",
    );

    expect(config).toBeDefined();
    expect(config?.module.name).toBe("openai");
    expect(config?.module.versionRange).toBe(">=4.87.0");
    expect(config?.module.filePath).toBe("resources/responses/responses.mjs");
    expect((config?.functionQuery as any).className).toBe("Responses");
    expect((config?.functionQuery as any).methodName).toBe("stream");
    expect((config?.functionQuery as any).kind).toBe("Sync");
  });

  it("should have responses.parse config with version >=4.87.0", () => {
    const config = openaiConfigs.find(
      (c) => c.channelName === "responses.parse",
    );

    expect(config).toBeDefined();
    expect(config?.module.name).toBe("openai");
    expect(config?.module.versionRange).toBe(">=4.87.0");
    expect(config?.module.filePath).toBe("resources/responses/responses.mjs");
    expect((config?.functionQuery as any).className).toBe("Responses");
    expect((config?.functionQuery as any).methodName).toBe("parse");
    expect((config?.functionQuery as any).kind).toBe("Async");
  });
});
