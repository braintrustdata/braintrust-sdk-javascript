import { debugLogger } from "../debug-logger";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Attachment, _exportsForTestingOnly, initLogger } from "../logger";
import { DecisionAttachmentProcessor } from "../decision-attachments";
import {
  configureInstrumentation,
  registry,
} from "../instrumentation/registry";
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
    registry.disable();
    configureInstrumentation({ spanCustomizers: [] });
    registry.enable();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("returns unsupported clients unchanged", () => {
    const warnSpy = vi
      .spyOn(debugLogger.notice, "warn")
      .mockImplementation(() => {});
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
        questions: [
          { id: "category", type: "choice" },
          { id: "urgent", type: "noul" },
        ],
        state: { message: "Charged twice" },
      },
      metadata: { model: "jev-1.13.0", provider: "typesafe" },
      metrics: { completion_tokens: 5, prompt_tokens: 20, tokens: 25 },
      output: {
        answers: [
          { ...result.answers.category, id: "category" },
          { ...result.answers.urgent, id: "urgent" },
        ],
      },
      span_attributes: { name: "typesafe.systemOne", type: "decision" },
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

  it("logs image references and box answers without reading bytes when capture is disabled", async () => {
    vi.stubEnv("BRAINTRUST_CAPTURE_ATTACHMENTS", "false");
    const readData = vi.fn(() => {
      throw new Error("Image bytes must not be observed");
    });
    const image = {
      [Symbol.for("@typesafe-ai/sdk/image")]: true,
      type: "image",
      get data() {
        return readData();
      },
      toString: () => "<image:1234>",
    };
    const template = {
      [Symbol.for("@typesafe-ai/sdk/text-with-assets")]: true,
      text: "Locate the ship in <image:1234>",
      assets: [image],
    };
    const request = {
      state: Object.assign(Object.create(null), {
        photo: image,
        description: template,
      }),
      assets: { "<photo>": image },
      questions: { ship: { type: "box", instructions: template } },
    };
    const result = {
      model: "jev-1.14.0",
      answers: {
        ship: {
          type: "box",
          box: { top: 0.1, bottom: 0.8, left: 0.2, right: 0.7 },
          confidence: null,
        },
      },
      usage: { input_tokens: 10, output_tokens: null },
    };
    const promise = responsePromise(result);
    const provider = {
      systemOne: vi.fn(function (this: unknown, actual: unknown) {
        expect(this).toBe(provider);
        expect(actual).toBe(request);
        return promise;
      }),
    };
    const wrapped = wrapTypeSafe(provider);
    expect(wrapped.systemOne(request)).toBe(promise);
    await promise;
    const [span] = await backgroundLogger.drain();
    expect(span).toMatchObject({
      input: {
        state: {
          photo: { type: "image" },
          description: ["Locate the ship in ", { type: "image" }],
        },
        questions: [
          {
            id: "ship",
            type: "box",
            instructions: ["Locate the ship in ", { type: "image" }],
          },
        ],
      },
      output: { answers: [{ id: "ship", ...result.answers.ship }] },
      metrics: { prompt_tokens: 10 },
    });
    expect(readData).not.toHaveBeenCalled();
    expect(provider.systemOne).toHaveBeenCalledTimes(1);
    expect(request.state.photo).toBe(image);
    expect(template.text).toBe("Locate the ship in <image:1234>");
  });

  it.each(["bytes", "blob"])(
    "captures %s at every input location and snapshots caller-owned bytes",
    async (kind) => {
      vi.stubEnv("BRAINTRUST_CAPTURE_ATTACHMENTS", "true");
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]);
      const originalBytes = bytes.slice();
      const image = {
        [Symbol.for("@typesafe-ai/sdk/image")]: true,
        type: "image",
        data:
          kind === "blob" ? new Blob([bytes], { type: "image/png" }) : bytes,
        toString: () => "<image:1234>",
      };
      const client = wrapTypeSafe({
        systemOne: (_request: unknown) => responsePromise({ answers: {} }),
      });
      const promise = client.systemOne({
        state: [image, "<first>", "<second>"],
        questions: { match: { type: "noul", instructions: [image] } },
        assets: { "<first>": image, "<second>": image },
      });
      bytes.fill(0);
      await promise;
      const [span] = await backgroundLogger.drain();
      const media = `data:image/png;base64,${Buffer.from(originalBytes).toString("base64")}`;
      expect(span).toMatchObject({
        input: {
          state: [media, media, media],
          questions: [{ id: "match", instructions: [media] }],
        },
      });
      expect((span as any).input).not.toHaveProperty("assets");
    },
  );

  it.each(["state", "instructions"])(
    "uses escaped input-rooted image paths in %s and preserves reordered mixed answers",
    async (location) => {
      vi.stubEnv("BRAINTRUST_CAPTURE_ATTACHMENTS", "true");
      const image = {
        [Symbol.for("@typesafe-ai/sdk/image")]: true,
        type: "image",
        data: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
        toString: () => "<image:1234>",
      };
      const nested = { "photos~/": [image] };
      const box = { top: 0, bottom: 1, left: 0.123456789, right: 1 };
      const answers = {
        missing: { type: "box", box },
        present: { type: "noul", noul: 0.001 },
        zero: { type: "box", box, confidence: 0 },
        nullable: { type: "box", box, confidence: null },
        invalid: {
          type: "box",
          box: { top: 2, bottom: -1, left: 0.9, right: 0.1 },
          confidence: 0.01,
        },
      };
      const questions = {
        zero: {
          type: "box",
          instructions: location === "instructions" ? nested : "Find target",
        },
        nullable: { type: "box", instructions: "Find target" },
        present: { type: "noul", instructions: "Is target present?" },
        missing: { type: "box", instructions: "Find target" },
        invalid: { type: "box", instructions: "Find target" },
      };
      const client = wrapTypeSafe({
        systemOne: (_request: unknown) => responsePromise({ answers }),
      });
      await expect(
        client.systemOne({
          state: location === "state" ? nested : "Inspect",
          questions,
        }),
      ).resolves.toEqual({ answers });
      const [span] = await backgroundLogger.drain();
      const imagePath = `${location === "state" ? "/state" : "/questions/0/instructions"}/photos~0~1/0`;
      expect(span).toMatchObject({
        span_attributes: { type: "decision" },
        output: {
          answers: Object.entries(answers).map(([id, answer]) => ({
            ...answer,
            id,
            ...(answer.type === "box" ? { image_path: imagePath } : {}),
          })),
        },
      });
      expect((span as any).input.questions).toEqual(
        Object.entries(questions).map(([id, question]) => ({
          ...question,
          id,
          ...(id === "zero" && location === "instructions"
            ? {
                instructions: {
                  "photos~/": ["data:image/png;base64,iVBORw0KGgo="],
                },
              }
            : {}),
        })),
      );
      expect(span).not.toHaveProperty("scores");
      expect(span).not.toHaveProperty("classifications");
      expect((span as any).output.answers[0]).not.toHaveProperty("confidence");
    },
  );

  it.each([false, true])(
    "leaves ambiguous image associations unresolved (repeated image: %s)",
    async (repeated) => {
      const image = {
        [Symbol.for("@typesafe-ai/sdk/image")]: true,
        type: "image",
        toString: () => "<image:1234>",
      };
      const answers = {
        target: { type: "box", box: { top: 0, bottom: 1, left: 0, right: 1 } },
      };
      const client = wrapTypeSafe({
        systemOne: (_request: unknown) => responsePromise({ answers }),
      });
      vi.stubEnv("BRAINTRUST_CAPTURE_ATTACHMENTS", "false");
      await client.systemOne({
        state: [
          image,
          repeated ? image : { ...image, toString: () => "<image:5678>" },
        ],
        questions: {
          target: { type: "box", instructions: "Target in the first image" },
        },
      });
      const [span] = await backgroundLogger.drain();
      expect(span).toMatchObject({
        input: { state: [{ type: "image" }, { type: "image" }] },
        output: { answers: [{ id: "target", ...answers.target }] },
      });
      expect((span as any).output.answers[0]).not.toHaveProperty("image_path");
    },
  );

  it.each(["success", "upload failure", "move", "redact"])(
    "keeps image paths consistent through %s without restoring customized media",
    async (mode) => {
      vi.stubEnv("BRAINTRUST_CAPTURE_ATTACHMENTS", "true");
      const upload = vi
        .spyOn(Attachment.prototype, "upload")
        .mockResolvedValue(
          mode === "upload failure"
            ? { upload_status: "error", error_message: "injected" }
            : { upload_status: "done" },
        );
      if (mode === "move" || mode === "redact") {
        registry.disable();
        configureInstrumentation({
          spanCustomizers: [
            {
              onSpanExport(data) {
                if (data.input && data.output) {
                  const input = data.input as any;
                  const answer = (data.output as any).answers[0];
                  if (mode === "move") {
                    input.state = { moved: input.state.photo };
                    answer.image_path = "/state/moved";
                  } else {
                    input.state = "[redacted]";
                    delete answer.image_path;
                  }
                }
                return data;
              },
            },
          ],
        });
      }
      registry.enable();
      const image = {
        [Symbol.for("@typesafe-ai/sdk/image")]: true,
        type: "image",
        data: new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])]),
        toString: () => "<image:1234>",
      };
      const box = {
        type: "box",
        box: { top: 0, bottom: 1, left: 0, right: 1 },
      };
      const client = wrapTypeSafe({
        systemOne: (_request: unknown) =>
          responsePromise({ answers: { target: box } }),
      });
      await client.systemOne({
        state: { photo: image },
        questions: { target: { type: "box", instructions: "Find target" } },
      });
      const [span] = await backgroundLogger.drain();
      const exported = await new DecisionAttachmentProcessor().process(
        span as any,
      );
      const path = mode === "move" ? "/state/moved" : "/state/photo";
      expect(exported.output.answers).toEqual([
        {
          ...box,
          id: "target",
          ...(mode !== "redact" ? { image_path: path } : {}),
        },
      ]);
      if (mode === "redact") {
        expect(exported.input.state).toBe("[redacted]");
        expect(upload).not.toHaveBeenCalled();
      } else {
        const media = exported.input.state[mode === "move" ? "moved" : "photo"];
        if (mode === "upload failure")
          expect(media).toBe("data:image/png;base64,iVBORw0KGgo=");
        else
          expect(media).toMatchObject({
            type: "braintrust_attachment",
            content_type: "image/png",
          });
        expect(upload).toHaveBeenCalledTimes(1);
      }
    },
  );

  it("keeps the span and box answer when image capture fails", async () => {
    vi.stubEnv("BRAINTRUST_CAPTURE_ATTACHMENTS", "true");
    const image = {
      [Symbol.for("@typesafe-ai/sdk/image")]: true,
      get data() {
        throw new Error("unreadable");
      },
      toString: () => "<image:1234>",
    };
    const answer = {
      type: "box",
      box: { top: -1, bottom: 0, left: 1, right: 0 },
      confidence: null,
    };
    const client = wrapTypeSafe({
      systemOne: (_request: unknown) =>
        responsePromise({ answers: { target: answer } }),
    });
    await expect(
      client.systemOne({
        state: image,
        questions: { target: { type: "box", instructions: "Find target" } },
      }),
    ).resolves.toEqual({ answers: { target: answer } });
    const [span] = await backgroundLogger.drain();
    expect(span).toMatchObject({
      input: { state: "<image:1234>" },
      output: { answers: [{ ...answer, id: "target", image_path: "/state" }] },
    });
  });

  it("preserves JSON serialization of non-asset state objects", async () => {
    const date = new Date("2026-10-15T00:00:00Z");
    const client = wrapTypeSafe({
      systemOne: (_request: unknown) => responsePromise({ answers: {} }),
    });
    await client.systemOne({ state: { date }, questions: {} });
    const [span] = await backgroundLogger.drain();
    expect(span).toMatchObject({
      input: { state: { date: date.toISOString() } },
    });
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
