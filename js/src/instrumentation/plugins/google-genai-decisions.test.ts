/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/consistent-type-assertions */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  _exportsForTestingOnly,
  initLogger,
  Attachment,
  traced,
  type TestBackgroundLogger,
} from "../../logger";
import { automaticAttachmentOriginals } from "../../automatic-attachments";
import { configureNode } from "../../node/config";
import { wrapGoogleGenAI } from "../../wrappers/google-genai";
import { googleGenAIChannels } from "./google-genai-interceptors";
import type {
  GoogleGenAIDecisionCreateParams,
  GoogleGenAIDecisionResponse,
  GoogleGenAIDecisions,
} from "../../vendor-sdk-types/google-genai";

configureNode();

const params: GoogleGenAIDecisionCreateParams = {
  model: "gemini-decision-1",
  input: "The problem is fixed.",
  questions: {
    resolved: { type: "noul", instructions: "Resolved?" },
    category: {
      type: "choice",
      instructions: "Which team?",
      criteria: { billing: "Payments", technical: "Bugs" },
    },
    urgency: {
      type: "score",
      instructions: "Urgency?",
      criteria: ["Low", "High"],
    },
  },
};
const response: GoogleGenAIDecisionResponse = {
  answers: {
    urgency: {
      type: "score",
      score: 0.25,
      confidence: 0.75,
      probabilities: { "0": 0.75, "1": 0.25 },
      legend: { "0": "Low", "1": "High" },
    },
    resolved: { type: "noul", noul: 0.9, confidence: 0.9 },
    category: {
      type: "choice",
      choice: "technical",
      confidence: 0.8,
      probabilities: { billing: 0.2, technical: 0.8 },
    },
  },
  usage: {
    total_input_tokens: 10,
    total_output_tokens: 0,
    total_tokens: 10,
    total_cached_tokens: 0,
  },
};

function client(create: GoogleGenAIDecisions["create"]) {
  const decisions = { create };
  const getDecisions = vi.fn(() => decisions);
  const sdk = {
    GoogleGenAI: class {
      models = {};
      chats = {};
      get decisions() {
        return getDecisions();
      }
    },
  };
  const wrapped = wrapGoogleGenAI(sdk);
  return { instance: new wrapped.GoogleGenAI(), decisions, getDecisions };
}

describe("Google GenAI decisions", () => {
  let logger: TestBackgroundLogger;
  beforeEach(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
    logger = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({
      projectName: "google-decisions.test",
      projectId: "test-project-id",
    });
  });
  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
    vi.unstubAllEnvs();
  });

  test("preserves the lazy client, receiver, options and promise; maps questions and reordered answers by ID", async () => {
    const promise = Promise.resolve(response);
    const create = vi.fn(function (this: unknown) {
      return promise;
    });
    const { instance, decisions, getDecisions } = client(create);
    expect(getDecisions).not.toHaveBeenCalled();
    expect(instance.decisions).toBe(instance.decisions);
    const options = {
      timeout: 1000,
      headers: { authorization: "secret-option" },
    };
    await traced(
      async () => {
        expect(instance.decisions.create(params, options)).toBe(promise);
        expect(await promise).toBe(response);
      },
      { name: "parent" },
    );
    expect(create).toHaveBeenCalledExactlyOnceWith(params, options);
    expect(create.mock.contexts[0]).toBe(decisions);
    const spans = (await logger.drain()) as any[];
    const parent = spans.find(
      (span) => span.span_attributes?.name === "parent",
    );
    const span = spans.find(
      (span) => span.span_attributes?.name === "create_decision",
    );
    expect(span).toMatchObject({
      span_attributes: { type: "decision" },
      span_parents: [parent?.span_id],
      input: {
        state: params.input,
        questions: [
          { id: "resolved", type: "boolean", instructions: "Resolved?" },
          { id: "category", ...params.questions.category },
          { id: "urgency", ...params.questions.urgency },
        ],
      },
      output: {
        answers: [
          { id: "urgency", ...response.answers!.urgency },
          { id: "resolved", type: "boolean", probability: 0.9 },
          { id: "category", ...response.answers!.category },
        ],
      },
      metadata: { model: params.model, provider: "google" },
      metrics: {
        prompt_tokens: 10,
        completion_tokens: 0,
        tokens: 10,
        prompt_cached_tokens: 0,
      },
    });
    expect(JSON.stringify(span)).not.toContain("secret-option");
  });

  test("captures only one span when manual and generated wrappers are combined", async () => {
    const create = vi.fn(async () => response);
    const { instance } = client((...args) =>
      googleGenAIChannels.decisionsCreate.invoke(create, undefined, args, {}),
    );
    await instance.decisions.create(params);
    expect(create).toHaveBeenCalledOnce();
    expect(
      ((await logger.drain()) as any[]).filter(
        (span) => span.span_attributes?.name === "create_decision",
      ),
    ).toHaveLength(1);
  });

  test.each(["throw", "reject"])(
    "preserves provider errors: %s",
    async (mode) => {
      const error = new Error("decision failed");
      const { instance } = client(() => {
        if (mode === "throw") throw error;
        return Promise.reject(error);
      });
      if (mode === "throw")
        expect(() => instance.decisions.create(params)).toThrow(error);
      else await expect(instance.decisions.create(params)).rejects.toBe(error);
      const spans = (await logger.drain()) as any[];
      expect(spans).toHaveLength(1);
      expect(spans[0]).toMatchObject({
        error: expect.stringContaining("decision failed"),
        metrics: { end: expect.any(Number) },
      });
    },
  );

  test.each([
    ["false", "false"],
    ["true", "false"],
    ["false", "true"],
  ])(
    "omits recordings with shared=%s recording=%s",
    async (shared, recording) => {
      vi.stubEnv("BRAINTRUST_CAPTURE_ATTACHMENTS", shared);
      vi.stubEnv("BRAINTRUST_CAPTURE_USER_AUDIO_ATTACHMENTS", recording);
      const { instance } = client(async () => response);
      await instance.decisions.create({
        ...params,
        input: [
          {
            type: "audio",
            mime_type: "audio/wav",
            data: "cHJpdmF0ZSBhdWRpbw==",
          },
          {
            type: "video",
            mime_type: "video/mp4",
            data: "cHJpdmF0ZSB2aWRlbw==",
          },
        ],
      });
      const spans = (await logger.drain()) as any[];
      expect(spans[0].input).toMatchObject({
        state: [
          { type: "audio", data: "<omitted>" },
          { type: "video", data: "<omitted>" },
        ],
      });
    },
  );

  test("omits inline images by default and preserves remote references and provider input", async () => {
    vi.stubEnv("BRAINTRUST_CAPTURE_ATTACHMENTS", "false");
    const { instance } = client(async () => response);
    const input = [
      { type: "image", mime_type: "image/png", data: "aW1hZ2U=" },
      { type: "image", uri: "https://example.com/image.png" },
    ];
    await instance.decisions.create({ ...params, input });
    const spans = (await logger.drain()) as any[];
    expect(spans[0].input).toMatchObject({
      state: [
        { type: "image", mime_type: "image/png", data: "<omitted>" },
        input[1],
      ],
    });
    expect(input[0].data).toBe("aW1hZ2U=");
  });

  test.each(
    [
      { shared: "false", recording: "false" },
      { shared: "true", recording: "false" },
      { shared: "false", recording: "true" },
      { shared: "true", recording: "true" },
    ].flatMap((flags) =>
      ["object", "array"].map((shape) => ({ ...flags, shape })),
    ),
  )(
    "applies capture controls to $shape instructions with shared=$shared recording=$recording",
    async ({ shared, recording, shape }) => {
      vi.stubEnv("BRAINTRUST_CAPTURE_ATTACHMENTS", shared);
      vi.stubEnv("BRAINTRUST_CAPTURE_USER_AUDIO_ATTACHMENTS", recording);
      const create = vi.fn(async () => response);
      const { instance } = client(create);
      for (const [type, mime_type] of [
        ["image", "image/png"],
        ["audio", "audio/wav"],
        ["video", "video/mp4"],
      ]) {
        const media = Object.freeze({ type, mime_type, data: "aGVsbG8=" });
        const text = { type: "text", text: "Inspect the media." };
        const remote = { type, uri: "https://example.com/media" };
        const instructions = shape === "array" ? [text, media, remote] : media;
        const request: GoogleGenAIDecisionCreateParams = {
          ...params,
          questions: { media: { type: "noul", instructions } },
        };
        await instance.decisions.create(request);
        expect(create).toHaveBeenLastCalledWith(request);
        const [span] = (await logger.drain()) as any[];
        const logged = span.input.questions[0].instructions;
        const loggedMedia = shape === "array" ? logged[1] : logged;
        expect(loggedMedia).toMatchObject({ type, mime_type });
        if (shared === "true" && (type === "image" || recording === "true")) {
          expect(loggedMedia.data).toBeInstanceOf(Attachment);
          expect(automaticAttachmentOriginals.get(loggedMedia.data)).toBe(
            media.data,
          );
        } else {
          expect(loggedMedia.data).toBe("<omitted>");
          expect(JSON.stringify(span.input)).not.toContain(media.data);
        }
        if (shape === "array") {
          expect(logged[0]).toEqual(text);
          expect(logged[2]).toEqual(remote);
        }
        expect(request.questions.media.instructions).toBe(instructions);
        expect(media.data).toBe("aGVsbG8=");
      }
    },
  );

  test("captures opted-in media and retains originals for export fallback", async () => {
    vi.stubEnv("BRAINTRUST_CAPTURE_ATTACHMENTS", "true");
    vi.stubEnv("BRAINTRUST_CAPTURE_USER_AUDIO_ATTACHMENTS", "true");
    const { instance } = client(async () => response);
    const input = [
      { type: "image", mime_type: "image/png", data: "aGVsbG8=" },
      { type: "document", mime_type: "application/pdf", data: "aGVsbG8=" },
      { type: "audio", mime_type: "audio/wav", data: "aGVsbG8=" },
      { type: "video", mime_type: "video/mp4", data: "aGVsbG8=" },
      { type: "image", mime_type: "image/png", data: "invalid%%" },
      { type: "image", data: "aGVsbG8=" },
    ];
    await instance.decisions.create({ ...params, input });
    const [span] = (await logger.drain()) as any[];
    const state = (span.input as { state: { data: unknown }[] }).state;
    for (let i = 0; i < 4; i++) {
      expect(state[i].data).toBeInstanceOf(Attachment);
      expect(automaticAttachmentOriginals.get(state[i].data as object)).toBe(
        input[i].data,
      );
    }
    expect(state.slice(4)).toEqual(input.slice(4));
    expect(input[0].data).toBe("aGVsbG8=");
  });

  test("leaves older SDK clients without decisions unchanged", () => {
    const sdk = {
      GoogleGenAI: class {
        models = {};
        chats = {};
      },
    };
    const wrapped = wrapGoogleGenAI(sdk);
    expect(
      (new wrapped.GoogleGenAI() as { decisions?: unknown }).decisions,
    ).toBeUndefined();
  });

  test("preserves question IDs and choice keys that look like prototype properties", async () => {
    const questions = JSON.parse(
      '{"__proto__":{"type":"choice","instructions":"Pick","criteria":{"constructor":"a","__proto__":"b"}}}',
    );
    const answers = JSON.parse(
      '{"__proto__":{"type":"choice","choice":"__proto__","confidence":1,"probabilities":{"constructor":0,"__proto__":1}}}',
    );
    const { instance } = client(async () => ({ answers }));
    await instance.decisions.create({ ...params, questions });
    const [span] = (await logger.drain()) as any[];
    expect(span.input).toMatchObject({
      questions: [{ id: "__proto__", criteria: questions.__proto__.criteria }],
    });
    expect(span.output).toMatchObject({
      answers: [
        {
          id: "__proto__",
          choice: "__proto__",
          probabilities: answers.__proto__.probabilities,
        },
      ],
    });
    expect(span.metrics).not.toHaveProperty("tokens");
  });
});
