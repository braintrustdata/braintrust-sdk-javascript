/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/consistent-type-assertions */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vite-plus/test";
import OpenAI from "openai";
import { _exportsForTestingOnly } from "../../logger/testing";
import {
  initLogger,
  Attachment,
  traced,
  type TestBackgroundLogger,
} from "../../logger/core";
import { configureNode } from "../../node/config";
import { wrapOpenAI } from "../../wrappers/oai";
import { registerInstrumentation } from "../registrations/openai";
import { openAIChannels } from "./openai-interceptors";
import type {
  OpenAIDecision,
  OpenAIDecisionCreateParams,
} from "../../vendor-sdk-types/openai-decisions";

configureNode();

const params: OpenAIDecisionCreateParams = {
  model: "gpt-6-luna",
  input: "Charged twice",
  questions: [
    { type: "predicate", name: "duplicate", instructions: "Duplicate charge?" },
    {
      type: "choice",
      name: "category",
      instructions: "Which team?",
      choices: [
        { value: "billing" },
        { value: "technical", description: "Bugs" },
      ],
    },
    {
      type: "score",
      name: "urgency",
      instructions: "How urgent?",
      levels: [{ label: "low" }, { label: "high", description: "Urgent" }],
    },
    { type: "predicate", instructions: "Unanswerable?" },
  ],
};
const response: OpenAIDecision = {
  model: "gpt-6-luna-resolved",
  answers: [
    { name: "duplicate", type: "predicate", probability: 0.95 },
    {
      name: "category",
      type: "choice",
      choice: "billing",
      confidence: 0.9,
      probabilities: [
        { value: "billing", probability: 0.9 },
        { value: "technical", probability: 0.1 },
      ],
    },
    {
      name: "urgency",
      type: "score",
      score: 0.8,
      confidence: 0.7,
      probabilities: [
        { value: 0, label: "low", probability: 0.2 },
        { value: 1, label: "high", probability: 0.8 },
      ],
    },
    { name: null, type: "refusal" },
  ],
  usage: {
    input_tokens: 20,
    output_tokens: 0,
    total_tokens: 20,
    input_tokens_details: { cached_tokens: 10, cache_write_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  },
};

function client(
  create: (
    params: OpenAIDecisionCreateParams,
    options?: unknown,
  ) => Promise<OpenAIDecision>,
) {
  return {
    chat: { completions: { create: vi.fn() } },
    embeddings: {},
    moderations: {},
    decisions: { create },
  };
}

describe("OpenAI decisions", () => {
  let logger: TestBackgroundLogger;
  beforeEach(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
    logger = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({
      projectName: "openai-decisions.test",
      projectId: "test-project-id",
    });
  });
  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
    vi.unstubAllEnvs();
  });

  test("matches the question span contract, preserves input and parent context", async () => {
    const original = Promise.resolve(response);
    const create = vi.fn(() => original);
    const wrapped = wrapOpenAI(client(create));
    const options = { timeout: 1000 };
    await traced(
      async () => {
        expect(wrapped.decisions.create(params, options)).toBe(original);
        expect(await original).toBe(response);
      },
      { name: "parent" },
    );
    expect(create).toHaveBeenCalledExactlyOnceWith(params, options);
    const spans = (await logger.drain()) as any[];
    const parent = spans.find((span) => span.span_attributes.name === "parent");
    const span = spans.find(
      (span) => span.span_attributes.name === "openai.decisions.create",
    );
    expect(span).toMatchObject({
      span_attributes: { type: "question" },
      span_parents: [parent.span_id],
      input: {
        state: "Charged twice",
        questions: [
          {
            id: "duplicate",
            type: "boolean",
            instructions: "Duplicate charge?",
          },
          {
            id: "category",
            type: "choice",
            instructions: "Which team?",
            criteria: { billing: null, technical: "Bugs" },
          },
          {
            id: "urgency",
            type: "score",
            instructions: "How urgent?",
            criteria: ["low", "high: Urgent"],
          },
          { id: "3", type: "boolean", instructions: "Unanswerable?" },
        ],
      },
      output: {
        answers: [
          { id: "duplicate", type: "boolean", probability: 0.95 },
          {
            id: "category",
            type: "choice",
            choice: "billing",
            confidence: 0.9,
            probabilities: { billing: 0.9, technical: 0.1 },
          },
          {
            id: "urgency",
            type: "score",
            score: 0.8,
            confidence: 0.7,
            probabilities: { 0: 0.2, 1: 0.8 },
            legend: { 0: "low", 1: "high" },
          },
          { id: "3", type: "refusal" },
        ],
      },
      metadata: { model: response.model, provider: "openai" },
      metrics: {
        prompt_tokens: 20,
        completion_tokens: 0,
        tokens: 20,
        prompt_cached_tokens: 10,
        prompt_cache_write_tokens: 0,
        completion_reasoning_tokens: 0,
      },
    });
    expect(params.questions[0].type).toBe("predicate");
    expect(response.answers[0].type).toBe("predicate");
  });

  test("deduplicates manual and automatic instrumentation and strips span_info", async () => {
    const create = vi.fn(
      async (_params: OpenAIDecisionCreateParams) => response,
    );
    const auto = client((...args) =>
      openAIChannels.decisionsCreate.invoke(create, undefined, args, {}),
    );
    const wrapped = wrapOpenAI(wrapOpenAI(auto));
    await wrapped.decisions.create({
      ...params,
      span_info: { name: "custom", metadata: { customer: "test" } },
    } as any);
    expect(create.mock.calls[0][0]).not.toHaveProperty("span_info");
    const spans = (await logger.drain()) as any[];
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      span_attributes: { name: "custom" },
      metadata: { customer: "test" },
    });
  });

  test.each([true, false])(
    "preserves provider errors (synchronous: %s)",
    async (synchronous) => {
      const error = new Error("Decision failed");
      const wrapped = wrapOpenAI(
        client(() => {
          if (synchronous) throw error;
          return Promise.reject(error);
        }),
      );
      if (synchronous)
        expect(() => wrapped.decisions.create(params)).toThrow(error);
      else await expect(wrapped.decisions.create(params)).rejects.toBe(error);
      const [span] = (await logger.drain()) as any[];
      expect(span.error).toContain("Decision failed");
      expect(span.metrics.end).toEqual(expect.any(Number));
    },
  );

  test("preserves typed choice collisions and prototype-sensitive keys", async () => {
    const values = [true, "true", "__proto__"];
    const wrapped = wrapOpenAI(
      client(async () => ({
        model: params.model,
        answers: [
          {
            type: "choice",
            name: "__proto__",
            choice: true,
            confidence: 0.8,
            probabilities: values.map((value, i) => ({
              value,
              probability: i === 0 ? 0.8 : 0.1,
            })),
          },
        ],
      })),
    );
    await wrapped.decisions.create({
      ...params,
      questions: [
        {
          type: "choice",
          name: "__proto__",
          instructions: "Choose",
          choices: values.map((value) => ({ value })),
        },
      ],
    });
    const [span] = (await logger.drain()) as any[];
    expect(span.output.answers[0]).toMatchObject({
      id: "__proto__",
      choice: "true",
      probabilities: { true: 0.8, '"true"': 0.1, '"__proto__"': 0.1 },
    });
    expect(Object.keys(span.input.questions[0].criteria)).toEqual([
      "true",
      '"true"',
      '"__proto__"',
    ]);
  });

  test("omits inline images by default without modifying caller input", async () => {
    vi.stubEnv("BRAINTRUST_AUTO_CAPTURE_ATTACHMENTS", "false");
    const input: OpenAIDecisionCreateParams["input"] = [
      {
        role: "user",
        content: [
          { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
          { type: "input_image", image_url: "https://example.com/image.png" },
        ],
      },
    ];
    await wrapOpenAI(client(async () => response)).decisions.create({
      ...params,
      input,
    });
    const [span] = (await logger.drain()) as any[];
    expect(JSON.stringify(span.input)).not.toContain("aGVsbG8=");
    expect(JSON.stringify(span.input)).toContain(
      "https://example.com/image.png",
    );
    expect(JSON.stringify(input)).toContain("aGVsbG8=");
  });

  test.each(["wrapped", "channel"])(
    "captures mixed image inputs without changing the provider call (%s)",
    async (mode) => {
      vi.stubEnv("BRAINTRUST_AUTO_CAPTURE_ATTACHMENTS", "true");
      const image =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
      const request: OpenAIDecisionCreateParams = {
        ...params,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "first" },
              { type: "input_image", image_url: image, detail: "low" },
              { type: "input_text", text: "second" },
              { type: "input_image", image_url: image, detail: "high" },
            ],
          },
        ],
      };
      const before = structuredClone(request);
      const original = Promise.resolve(response);
      const create = vi.fn(
        (_request: OpenAIDecisionCreateParams, _options?: unknown) => original,
      );
      const target = client(create);
      const options = { timeout: 1000 };
      const promise =
        mode === "wrapped"
          ? wrapOpenAI(target).decisions.create(request, options)
          : openAIChannels.decisionsCreate.invoke(
              create,
              target.decisions,
              [request, options],
              {},
            );
      expect(promise).toBe(original);
      expect(await promise).toBe(response);
      expect(create.mock.calls[0][0]).toBe(request);
      expect(create.mock.calls[0][1]).toBe(options);
      expect(request).toEqual(before);
      const [span] = (await logger.drain()) as any[];
      expect(span.input.state[0].content).toEqual([
        { type: "input_text", text: "first" },
        {
          type: "input_image",
          image_url: expect.any(Attachment),
          detail: "low",
        },
        { type: "input_text", text: "second" },
        {
          type: "input_image",
          image_url: expect.any(Attachment),
          detail: "high",
        },
      ]);
      expect(span.input.questions.map((q: any) => q.id)).toEqual([
        "duplicate",
        "category",
        "urgency",
        "3",
      ]);
      expect(span.output.answers.map((a: any) => a.id)).toEqual([
        "duplicate",
        "category",
        "urgency",
        "3",
      ]);
    },
  );

  test.each([
    "await",
    "withResponse",
    "asResponse",
    "catch",
    "finally",
  ] as const)(
    "preserves APIPromise identity and captures output via %s",
    async (consume) => {
      const sdk = new OpenAI({
        apiKey: "test-key",
        fetch: async () =>
          Response.json(response, {
            headers: { "x-request-id": "test-request" },
          }),
      });
      const original = sdk.post<OpenAIDecision>("/decisions", { body: params });
      const wrapped = wrapOpenAI(client(() => original));
      const promise = wrapped.decisions.create(params) as typeof original;
      expect(promise).toBe(original);
      if (consume === "asResponse") {
        const raw = await promise.asResponse();
        expect(raw.bodyUsed).toBe(false);
        expect(await raw.json()).toEqual(response);
      } else if (consume === "withResponse") {
        const result = await promise.withResponse();
        expect(result.request_id).toBe("test-request");
        expect(result.data).toEqual(response);
        expect(await promise).toBe(result.data);
      } else if (consume === "catch") {
        expect(
          await promise.catch(() => {
            throw new Error("Unexpected rejection");
          }),
        ).toEqual(response);
      } else if (consume === "finally") {
        const callback = vi.fn();
        expect(await promise.finally(callback)).toEqual(response);
        expect(callback).toHaveBeenCalledOnce();
      } else {
        expect(await promise).toEqual(response);
      }
      const spans = (await logger.drain()) as any[];
      expect(spans).toHaveLength(1);
      expect(spans[0].output.answers).toHaveLength(4);
    },
  );

  test.each([
    "await",
    "withResponse",
    "asResponse",
    "catch",
    "finally",
  ] as const)(
    "captures APIPromise rejections via %s before returning to the caller",
    async (consume) => {
      const sdk = new OpenAI({
        apiKey: "test-key",
        maxRetries: 0,
        fetch: async () =>
          Response.json(
            { error: { message: "Decision rejected" } },
            { status: 400 },
          ),
      });
      const original = sdk.post<OpenAIDecision>("/decisions", { body: params });
      const promise = wrapOpenAI(client(() => original)).decisions.create(
        params,
      ) as typeof original;
      const consumed =
        consume === "withResponse"
          ? promise.withResponse()
          : consume === "asResponse"
            ? promise.asResponse()
            : consume === "catch"
              ? promise.catch((error) => {
                  throw error;
                })
              : consume === "finally"
                ? promise.finally(() => {})
                : promise;
      await expect(consumed).rejects.toThrow("Decision rejected");
      const [span] = (await logger.drain()) as any[];
      expect(span.error).toContain("Decision rejected");
      expect(span.metrics.end).toEqual(expect.any(Number));
    },
  );

  test("ends spans when result extraction fails without changing the result", async () => {
    const malformed: OpenAIDecision = {
      model: params.model,
      get answers(): never {
        throw new Error("Unreadable answers");
      },
    };
    expect(
      await wrapOpenAI(client(async () => malformed)).decisions.create(params),
    ).toBe(malformed);
    const [span] = (await logger.drain()) as any[];
    expect(span.metrics.end).toEqual(expect.any(Number));
  });

  test("supports older clients and idempotent registration", async () => {
    const older = { ...client(async () => response), decisions: undefined };
    expect(wrapOpenAI(older).decisions).toBeUndefined();
    const wrapped = wrapOpenAI(client(async () => response));
    registerInstrumentation();
    registerInstrumentation();
    await wrapped.decisions.create(params);
    expect(await logger.drain()).toHaveLength(1);
  });
});
