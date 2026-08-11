import { describe, expect, it, vi } from "vitest";
import { debugLogger } from "../debug-logger";
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
    const wrapped = wrapOllama(client);
    expect(wrapped.chat).toBe(wrapped.chat);
    expect(wrapped.generate).toBe(wrapped.generate);
    expect(wrapped.embed).toBe(wrapped.embed);
    await wrapped.chat?.({
      model: "gpt-oss:20b",
      messages: [{ role: "user", content: "Say OK." }],
    });
    await wrapped.generate?.({
      model: "gpt-oss:20b",
      prompt: "Say OK.",
    });
    await wrapped.embed?.({ model: "embeddinggemma", input: "hello" });

    expect(chatSpy).toHaveBeenCalledOnce();
    expect(generateSpy).toHaveBeenCalledOnce();
    expect(embedSpy).toHaveBeenCalledOnce();
    expect(wrapOllama(client)).toBe(wrapped);
    expect(wrapOllama(wrapped)).toBe(wrapped);
  });

  it("returns unsupported objects unchanged", () => {
    const client = {};
    const warn = vi.spyOn(debugLogger, "warn").mockImplementation(() => {});

    expect(wrapOllama(client)).toBe(client);
    expect(warn).toHaveBeenCalledWith(
      "Unsupported Ollama library. Not wrapping.",
    );
  });

  it("refreshes stable wrappers when client methods change", async () => {
    const originalChat = vi.fn(async () => ({
      message: { role: "assistant", content: "original" },
      done: true,
    }));
    const client: OllamaClient = { chat: originalChat };
    const tracePromise = vi
      .spyOn(ollamaChannels.chat, "tracePromise")
      .mockImplementation((fn) => fn());
    const wrapped = wrapOllama(client);
    const firstWrappedChat = wrapped.chat;

    expect(firstWrappedChat).toBe(wrapped.chat);

    const replacementChat = vi.fn(async () => ({
      message: { role: "assistant", content: "replacement" },
      done: true,
    }));
    client.chat = replacementChat;

    expect(wrapped.chat).not.toBe(firstWrappedChat);
    expect(wrapped.chat).toBe(wrapped.chat);
    await wrapped.chat?.({ model: "gpt-oss:20b", messages: [] });
    expect(originalChat).not.toHaveBeenCalled();
    expect(replacementChat).toHaveBeenCalledOnce();

    client.chat = undefined;
    expect(wrapped.chat).toBeUndefined();
    tracePromise.mockRestore();
  });
});
