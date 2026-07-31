import { describe, expect, it, vi } from "vitest";
import { ollamaChannels } from "../instrumentation/plugins/ollama-channels";
import type { OllamaClient } from "../vendor-sdk-types/ollama";
import { wrapOllama } from "./ollama";

describe("wrapOllama", () => {
  it("emits channel events for every supported generation surface", async () => {
    const client: OllamaClient = {
      chat: vi.fn(async () => ({
        message: { role: "assistant", content: "OK" },
        done: true,
      })),
      generate: vi.fn(async () => ({ response: "OK", done: true })),
      embed: vi.fn(async () => ({ embeddings: [[0.1, 0.2]] })),
      embeddings: vi.fn(async () => ({ embedding: [0.1, 0.2] })),
    };
    const chatSpy = vi
      .spyOn(ollamaChannels.chat, "tracePromise")
      .mockImplementation((fn) => fn());
    const generateSpy = vi
      .spyOn(ollamaChannels.generate, "tracePromise")
      .mockImplementation((fn) => fn());
    const embedSpy = vi
      .spyOn(ollamaChannels.embed, "tracePromise")
      .mockImplementation((fn) => fn());
    const embeddingsSpy = vi
      .spyOn(ollamaChannels.embeddings, "tracePromise")
      .mockImplementation((fn) => fn());

    const wrapped = wrapOllama(client);
    await wrapped.chat?.({
      model: "gpt-oss:20b",
      messages: [{ role: "user", content: "Say OK." }],
    });
    await wrapped.generate?.({
      model: "gpt-oss:20b",
      prompt: "Say OK.",
    });
    await wrapped.embed?.({ model: "embeddinggemma", input: "hello" });
    await wrapped.embeddings?.({
      model: "all-minilm",
      prompt: "hello",
    });

    expect(chatSpy).toHaveBeenCalledOnce();
    expect(generateSpy).toHaveBeenCalledOnce();
    expect(embedSpy).toHaveBeenCalledOnce();
    expect(embeddingsSpy).toHaveBeenCalledOnce();
    expect(wrapOllama(client)).toBe(wrapped);
    expect(wrapOllama(wrapped)).toBe(wrapped);
  });

  it("returns unsupported objects unchanged", () => {
    const client = {};
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(wrapOllama(client)).toBe(client);
    expect(warn).toHaveBeenCalledWith(
      "Unsupported Ollama library. Not wrapping.",
    );
  });
});
