import { afterEach, describe, expect, it, vi } from "vitest";

const { invoke, tracePromise } = vi.hoisted(() => ({
  invoke: vi.fn(
    (
      target: (...args: unknown[]) => unknown,
      thisArg: unknown,
      args: unknown[],
    ) => Reflect.apply(target, thisArg, args),
  ),
  tracePromise: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

vi.mock("../isomorph", () => ({
  default: {
    newTracingChannel: vi.fn(() => ({
      subscribe: vi.fn(),
      invoke,
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

  it("wraps models.generateImages without replacing its promise", async () => {
    const response = { generatedImages: [] };
    const providerPromise = Promise.resolve(response);
    const generateImages = vi.fn((_params: unknown) => providerPromise);
    const sdk = {
      GoogleGenAI: class {
        chats = {};
        models = {
          embedContent: vi.fn(),
          generateContent: vi.fn(),
          generateContentStream: vi.fn(),
          generateImages,
        };
      },
    };
    const params = {
      model: "imagen-4.0-generate-001",
      prompt: "A blue circle",
    };

    const wrapped = wrapGoogleGenAI(sdk);
    const client = new wrapped.GoogleGenAI();
    const result = client.models.generateImages(params);

    expect(result).toBe(providerPromise);
    await expect(result).resolves.toBe(response);
    expect(generateImages).toHaveBeenCalledWith(params);
    expect(invoke).toHaveBeenCalledWith(
      expect.any(Function),
      undefined,
      [params],
      {},
    );
  });

  it.each([
    ["editImage", { generatedImages: [] }],
    ["generateVideos", { done: false, name: "operations/video-1" }],
  ] as const)(
    "wraps models.%s without replacing its promise",
    async (methodName, response) => {
      const providerPromise = Promise.resolve(response);
      const providerMethod = vi.fn((_params: unknown) => providerPromise);
      const sdk = {
        GoogleGenAI: class {
          chats = {};
          models = {
            editImage: vi.fn(),
            embedContent: vi.fn(),
            generateContent: vi.fn(),
            generateContentStream: vi.fn(),
            generateImages: vi.fn(),
            generateVideos: vi.fn(),
            [methodName]: providerMethod,
          };
        },
      };
      const params =
        methodName === "editImage"
          ? {
              model: "imagen-3.0-capability-001",
              prompt: "Turn the circle green",
              referenceImages: [],
            }
          : {
              model: "veo-3.1-fast-generate-preview",
              prompt: "A short wave",
            };

      const wrapped = wrapGoogleGenAI(sdk);
      const client = new wrapped.GoogleGenAI();
      const result = client.models[methodName](params as never);

      expect(result).toBe(providerPromise);
      await expect(result).resolves.toBe(response);
      expect(providerMethod).toHaveBeenCalledWith(params);
      expect(invoke).toHaveBeenCalledWith(
        expect.any(Function),
        undefined,
        [params],
        {},
      );
    },
  );

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
