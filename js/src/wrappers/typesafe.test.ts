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
import type {
  TypeSafeAPIPromise,
  TypeSafeWithResponse,
} from "../vendor-sdk-types/typesafe";
import { wrapTypeSafe } from "./typesafe";

try {
  configureNode();
} catch {
  // Best-effort initialization for test environments.
}

class MockAPIPromise<T> implements TypeSafeAPIPromise<T> {
  readonly [Symbol.toStringTag] = "Promise";
  private parsed: Promise<T> | undefined;

  constructor(
    private readonly responsePromise: Promise<Response>,
    private readonly parse: (response: Response) => Promise<T>,
  ) {}

  private data(): Promise<T> {
    this.parsed ??= this.responsePromise.then(this.parse);
    return this.parsed;
  }

  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.data().then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<T | TResult> {
    return this.data().catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<T> {
    return this.data().finally(onfinally);
  }

  asResponse(): Promise<Response> {
    return this.responsePromise;
  }

  async withResponse(): Promise<TypeSafeWithResponse<T>> {
    const [data, response] = await Promise.all([
      this.data(),
      this.responsePromise,
    ]);
    return { data, response, requestId: "req_test" };
  }

  map<U>(fn: (data: T) => U): MockAPIPromise<U> {
    return new MockAPIPromise(this.responsePromise, async () =>
      fn(await this.data()),
    );
  }
}

function responsePromise(body: unknown): MockAPIPromise<any> {
  const response = Promise.resolve(
    new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    }),
  );
  return new MockAPIPromise(response, async (value) => value.json());
}

describe("TypeSafe wrapper", () => {
  let backgroundLogger: ReturnType<
    typeof _exportsForTestingOnly.useTestBackgroundLogger
  >;

  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
  });

  beforeEach(() => {
    backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({
      projectName: "typesafe.test.ts",
      projectId: "test-project-id",
    });
  });

  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
    vi.restoreAllMocks();
  });

  it("returns unsupported clients unchanged", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const unsupported = { models: {} };

    expect(wrapTypeSafe(unsupported)).toBe(unsupported);
    expect(warnSpy).toHaveBeenCalledWith(
      "Unsupported TypeSafe AI library. Not wrapping.",
    );
  });

  it("captures native questions, answers, model, and token usage", async () => {
    const result = {
      answers: {
        category: {
          choice: "billing",
          confidence: 0.9,
          probabilities: { billing: 0.95, technical: 0.05 },
          type: "choice",
        },
        urgent: { noul: 0.8, type: "noul" },
      },
      model: "jev-1.13.0",
      usage: { input_tokens: 20, output_tokens: 5 },
    };
    const original = responsePromise(result);
    const client = wrapTypeSafe({
      defaultModel: "jev-latest",
      systemOne: vi.fn(() => original),
    } as any) as any;

    const returned = client.systemOne({
      state: { message: "Charged twice" },
      questions: {
        category: {
          criteria: { billing: null, technical: null },
          instructions: "Which team?",
          type: "choice",
        },
        urgent: { instructions: "Is this urgent?", type: "noul" },
      },
    });

    expect(returned).toBe(original);
    await expect(returned).resolves.toEqual(result);

    const spans = await backgroundLogger.drain();
    const span = spans.find(
      (candidate: any) =>
        candidate.span_attributes?.name === "typesafe.systemOne",
    ) as Record<string, any> | undefined;
    expect(span).toMatchObject({
      input: {
        questions: {
          category: { type: "choice" },
          urgent: { type: "noul" },
        },
        state: { message: "Charged twice" },
      },
      metadata: { model: "jev-1.13.0", provider: "typesafe" },
      metrics: { completion_tokens: 5, prompt_tokens: 20, tokens: 25 },
      output: result.answers,
      span_attributes: { name: "typesafe.systemOne", type: "llm" },
    });
  });

  it("preserves APIPromise helpers and the raw response body", async () => {
    const result = {
      answers: { valid: { noul: 1, type: "noul" } },
      model: "jev-1.13.0",
      usage: { input_tokens: 4, output_tokens: 1 },
    };
    const original = responsePromise(result);
    const client = wrapTypeSafe({
      systemOne: vi.fn(() => original),
    } as any) as any;

    const promise = client.systemOne({ state: "hello", questions: {} });
    expect(promise).toBe(original);
    expect(typeof promise.asResponse).toBe("function");
    expect(typeof promise.withResponse).toBe("function");
    expect(typeof promise.map).toBe("function");

    const raw = await promise.asResponse();
    expect(raw.bodyUsed).toBe(false);
    await expect(raw.json()).resolves.toEqual(result);

    const mappedPromise = responsePromise(result);
    const mappedClient = wrapTypeSafe({
      systemOne: vi.fn(() => mappedPromise),
    } as any) as any;
    const mapped = mappedClient
      .systemOne({ state: "hello", questions: {} })
      .map((value: any) => value.model);
    await expect(mapped).resolves.toBe("jev-1.13.0");
  });

  it("preserves synchronous and asynchronous provider errors", async () => {
    const syncError = new Error("invalid questions");
    const syncClient = wrapTypeSafe({
      systemOne: vi.fn(() => {
        throw syncError;
      }),
    } as any) as any;

    expect(() =>
      syncClient.systemOne({ state: "hello", questions: {} }),
    ).toThrow(syncError);

    const asyncError = new Error("request failed");
    const rejected = new MockAPIPromise<any>(
      Promise.reject(asyncError),
      async () => undefined,
    );
    const asyncClient = wrapTypeSafe({
      systemOne: vi.fn(() => rejected),
    } as any) as any;
    await expect(
      asyncClient.systemOne({ state: "hello", questions: {} }),
    ).rejects.toBe(asyncError);

    const spans = await backgroundLogger.drain();
    const errors = spans
      .filter(
        (candidate: any) =>
          candidate.span_attributes?.name === "typesafe.systemOne",
      )
      .map((span: any) => span.error);
    expect(errors).toHaveLength(2);
    expect(errors.every((error) => error !== undefined)).toBe(true);
  });
});
