import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { _exportsForTestingOnly, initLogger } from "../logger";
import { configureNode } from "../node/config";
import { wrapVoyageAI } from "./voyageai";

try {
  configureNode();
} catch {
  // Best-effort initialization for test environments.
}

describe("Voyage AI wrapper", () => {
  let backgroundLogger: ReturnType<
    typeof _exportsForTestingOnly.useTestBackgroundLogger
  >;

  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
  });

  beforeEach(() => {
    backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({
      projectName: "voyageai.test.ts",
      projectId: "test-project-id",
    });
  });

  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
    vi.restoreAllMocks();
  });

  it("returns unsupported clients unchanged", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const unsupported = { tokenize: vi.fn() };

    expect(wrapVoyageAI(unsupported)).toBe(unsupported);
    expect(warnSpy).toHaveBeenCalledWith(
      "Unsupported Voyage AI library. Not wrapping.",
    );
  });

  it("wraps all Voyage execution methods", async () => {
    const client = wrapVoyageAI({
      embed: vi.fn(async () => ({
        data: [{ embedding: [0.1, 0.2], index: 0 }],
        model: "voyage-4",
        usage: { totalTokens: 2 },
      })),
      multimodalEmbed: vi.fn(async () => ({
        data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }],
        model: "voyage-multimodal-3.5",
        usage: { totalTokens: 3 },
      })),
      rerank: vi.fn(async () => ({
        data: [{ index: 0, relevanceScore: 0.9 }],
        model: "rerank-2.5",
        usage: { totalTokens: 4 },
      })),
      contextualizedEmbed: vi.fn(async () => ({
        data: [
          {
            data: [{ embedding: [0.1, 0.2, 0.3, 0.4], index: 0 }],
            index: 0,
          },
        ],
        model: "voyage-context-3",
        usage: { totalTokens: 5 },
      })),
    } as any) as any;

    await client.embed({ input: "hello", model: "voyage-4" });
    await client.multimodalEmbed({
      inputs: [{ content: [{ type: "text", text: "hello" }] }],
      model: "voyage-multimodal-3.5",
    });
    await client.rerank({
      documents: ["Paris"],
      model: "rerank-2.5",
      query: "France",
    });
    await client.contextualizedEmbed({
      inputs: [["hello"]],
      model: "voyage-context-3",
    });

    const spans = await backgroundLogger.drain();
    expect(spans.map((span: any) => span.span_attributes?.name).sort()).toEqual(
      [
        "voyageai.contextualizedEmbed",
        "voyageai.embed",
        "voyageai.multimodalEmbed",
        "voyageai.rerank",
      ],
    );
  });

  it("preserves Voyage HttpResponsePromise helpers", async () => {
    class MockResponsePromise<T> extends Promise<T> {
      withRawResponse() {
        return Promise.resolve({
          data: "raw-data",
          rawResponse: "raw-response",
        });
      }
    }

    const originalPromise = new MockResponsePromise((resolve) => {
      resolve({
        data: [{ embedding: [0.1], index: 0 }],
        model: "voyage-4",
        usage: { totalTokens: 1 },
      });
    });
    const client = wrapVoyageAI({
      embed: vi.fn(() => originalPromise),
    } as any) as any;

    const resultPromise = client.embed({
      input: "hello",
      model: "voyage-4",
    });

    expect(resultPromise).toBe(originalPromise);
    await expect(resultPromise.withRawResponse()).resolves.toEqual({
      data: "raw-data",
      rawResponse: "raw-response",
    });
    await resultPromise;
    expect(await backgroundLogger.drain()).toHaveLength(1);
  });

  it("preserves provider errors", async () => {
    const providerError = new Error("Voyage request failed");
    const client = wrapVoyageAI({
      rerank: vi.fn(async () => {
        throw providerError;
      }),
    } as any) as any;

    await expect(
      client.rerank({
        documents: ["Paris"],
        model: "rerank-2.5",
        query: "France",
      }),
    ).rejects.toBe(providerError);
  });
});
