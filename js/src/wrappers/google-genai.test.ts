import { afterEach, describe, expect, it, vi } from "vitest";

const { tracePromise } = vi.hoisted(() => ({
  tracePromise: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

vi.mock("../isomorph", () => ({
  default: {
    newTracingChannel: vi.fn(() => ({
      subscribe: vi.fn(),
      tracePromise,
      unsubscribe: vi.fn(),
    })),
  },
}));

import { wrapGoogleGenAI } from "./google-genai";

describe("wrapGoogleGenAI", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("lazily wraps interactions.create and preserves request options", async () => {
    let interactionsGetCount = 0;
    const create = vi.fn(async (params: unknown, options?: unknown) => ({
      options,
      params,
    }));
    const interactions = { create };
    const sdk = {
      GoogleGenAI: class {
        chats = {};
        models = {
          embedContent: vi.fn(),
          generateContent: vi.fn(),
          generateContentStream: vi.fn(),
        };

        get interactions() {
          interactionsGetCount += 1;
          return interactions;
        }
      },
    };

    const wrapped = wrapGoogleGenAI(sdk);
    const client = new wrapped.GoogleGenAI();

    expect(interactionsGetCount).toBe(0);

    const params = {
      input: "Reply with OK.",
      model: "gemini-2.5-flash",
    };
    const options = { timeout: 1000 };
    const result = await client.interactions.create(params, options);

    expect(result).toEqual({ options, params });
    expect(interactionsGetCount).toBe(1);
    expect(create).toHaveBeenCalledWith(params, options);
    expect(tracePromise).toHaveBeenCalledWith(expect.any(Function), {
      arguments: [params, options],
    });
  });

  it("does not trace background interaction tasks", async () => {
    const create = vi.fn(async (params: unknown, options?: unknown) => ({
      options,
      params,
    }));
    const interactions = { create };
    const sdk = {
      GoogleGenAI: class {
        chats = {};
        models = {
          embedContent: vi.fn(),
          generateContent: vi.fn(),
          generateContentStream: vi.fn(),
        };

        get interactions() {
          return interactions;
        }
      },
    };

    const wrapped = wrapGoogleGenAI(sdk);
    const client = new wrapped.GoogleGenAI();
    const params = {
      background: true,
      input: "Research TPUs.",
      model: "gemini-2.5-flash",
    };
    const options = { timeout: 1000 };

    const result = await client.interactions.create(params, options);

    expect(result).toEqual({ options, params });
    expect(create).toHaveBeenCalledWith(params, options);
    expect(tracePromise).not.toHaveBeenCalled();
  });

  it("leaves clients without interactions unchanged", () => {
    const sdk = {
      GoogleGenAI: class {
        chats = {};
        models = {
          embedContent: vi.fn(),
          generateContent: vi.fn(),
          generateContentStream: vi.fn(),
        };
      },
    };

    const wrapped = wrapGoogleGenAI(sdk);
    const client = new wrapped.GoogleGenAI();

    expect((client as any).interactions).toBeUndefined();
    expect(tracePromise).not.toHaveBeenCalled();
  });
});
