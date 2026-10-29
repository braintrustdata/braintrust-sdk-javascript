import { resetInstrumentationForTest } from "../instrumentation/test-utils/reset";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { _exportsForTestingOnly } from "../logger/testing";
import { currentSpan, initLogger, traced } from "../logger/core";
import { configureNode } from "../node/config";
import { configureInstrumentation } from "../instrumentation/registry";
import { runWithAutoInstrumentationSuppressed } from "../instrumentation/auto-instrumentation-suppression";
import { TypedAttachmentProcessor } from "../typed-attachments";
import { Attachment } from "../logger/core";
import { wrapWorkersAI } from "./workers-ai";
import type { LoggingEvent } from "../../util/index";

configureNode();

const input = {
  model: "clef-flash",
  state: { ticket: "Checkout is down" },
  questions: {
    urgent: { type: "noul", instructions: "Is this urgent?" },
    team: {
      type: "choice",
      instructions: "Which team?",
      criteria: { engineering: null, billing: null },
    },
    severity: {
      type: "score",
      instructions: "Impact?",
      criteria: ["Low", "High"],
    },
  },
};
const result = {
  model: "clef-flash",
  answers: {
    severity: {
      type: "score",
      score: 0.75,
      probabilities: { "0": 0.25, "1": 0.75 },
    },
    urgent: { type: "noul", noul: 0.9 },
    team: {
      type: "choice",
      choice: "engineering",
      confidence: 0.8,
      probabilities: { engineering: 0.8, billing: 0.2 },
    },
  },
  usage: { input_tokens: 30, output_tokens: 0 },
};

describe("Workers AI binding", () => {
  let logger: ReturnType<typeof _exportsForTestingOnly.useTestBackgroundLogger>;

  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
  });
  beforeEach(() => {
    logger = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({
      projectName: "workers-ai.test",
      projectId: "test-project-id",
    });
  });
  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
    resetInstrumentationForTest();
    configureInstrumentation({ integrations: { workersAI: true } });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("preserves private receivers, accessors, method identity, arguments and promise helpers", async () => {
    const promise = Object.assign(Promise.resolve(result), {
      helper: () => "helper",
    });
    const options = { extraHeaders: { authorization: "never-log-this" } };
    class Binding {
      #value = 42;
      get value() {
        return this.#value;
      }
      other() {
        return this.#value;
      }
      run(...args: unknown[]) {
        expect(this.#value).toBe(42);
        expect(args).toEqual(["@cf/cloudflare/clef-flash", input, options]);
        expect(args[1]).toBe(input);
        expect(args[2]).toBe(options);
        return promise;
      }
    }
    const original = new Binding();
    const ai = wrapWorkersAI(original);
    expect(ai).toBeInstanceOf(Binding);
    expect(wrapWorkersAI(original)).toBe(ai);
    expect(wrapWorkersAI(ai)).toBe(ai);
    expect(ai.run).toBe(ai.run);
    expect(ai.other).toBe(ai.other);
    expect(ai.value).toBe(42);
    expect(ai.other()).toBe(42);
    const returned = ai.run("@cf/cloudflare/clef-flash", input, options);
    expect(returned).toBe(promise);
    expect(returned.helper()).toBe("helper");
    expect(await returned).toBe(result);
    const spans = await logger.drain();
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      span_attributes: { name: "workers_ai.run", type: "decision" },
      input: {
        state: input.state,
        questions: Object.entries(input.questions).map(([id, q]) => ({
          ...q,
          id,
        })),
      },
      output: {
        answers: Object.entries(result.answers).map(([id, a]) => ({
          ...a,
          id,
        })),
      },
      metadata: { model: "clef-flash", provider: "cloudflare" },
      metrics: { prompt_tokens: 30, completion_tokens: 0, tokens: 30 },
      context: { span_origin: { instrumentation: { name: "workers-ai" } } },
    });
    expect(JSON.stringify(spans)).not.toContain("never-log-this");
  });

  it("preserves extraction values, nulls, offsets and uncertainty without treating them as decisions", async () => {
    const response = {
      model: "clairic",
      truncated: true,
      state_text: "Invoice 42",
      answers: {
        id: {
          type: "text",
          value: "42",
          span: [8, 10],
          p_null: 0,
          confidence: 0.9,
        },
        missing: { type: "text", value: null, p_null: 1 },
        estimate: {
          type: "estimate",
          value: 3,
          median: 3,
          p10: 1,
          p90: 5,
          quantiles: [1, 3, 5],
        },
        forecast: {
          type: "forecast",
          value: [3],
          steps: [{ median: 3, p10: 1, p90: 5 }],
        },
      },
      usage: { input_tokens: 50, output_tokens: 0, passes: 3 },
    };
    const params = {
      state: "Invoice 42",
      fields: { id: { type: "text" } },
      reference_date: "2026-10-22",
      options: { include_quantiles: true },
    };
    const ai = wrapWorkersAI({ run: async (..._args: unknown[]) => response });
    await ai.run("@cf/cloudflare/clairic", params);
    const [span] = await logger.drain();
    expect(span).toMatchObject({
      input: { ...params, fields: [{ id: "id", type: "text" }] },
      output: {
        answers: Object.entries(response.answers).map(([id, answer]) => ({
          id,
          ...answer,
        })),
        truncated: true,
        state_text: "Invoice 42",
      },
      span_attributes: { type: "extraction" },
      metadata: {
        provider: "cloudflare",
        model: "clairic",
        operation: "extraction",
      },
      metrics: { prompt_tokens: 50, completion_tokens: 0, tokens: 50 },
    });
  });

  it("allowlists extraction fields, options and typed results while preserving falsy values and order", async () => {
    const fields = {
      text: { type: "text", instructions: "é𐐀", private: "omit-field" },
      number: { type: "number", integer: false, decimals: 0, unit: "USD" },
      date: { type: "date" },
      time: { type: "time" },
      datetime: { type: "datetime" },
      duration: { type: "duration", unit: "days" },
      list: { type: "list", items: "date" },
      estimate: {
        type: "estimate",
        min: "2026-10-01",
        max: "2026-12-01",
        step: "month",
        scale: "linear",
      },
      forecast: {
        type: "forecast",
        min: 0,
        max: 5,
        horizon: 2,
        interval: "day",
        null_threshold: 0.5,
      },
    };
    const answers = {
      forecast: {
        type: "forecast",
        value: [0, 1.23456789],
        mean: [0, 1.2],
        median: [0, 1],
        p10: [0, 0.2],
        p90: [2, 3],
        p_below: [0, null],
        p_above: [0.1, 0.2],
        quantiles: [
          [0, 1],
          [2, 3],
        ],
        steps: [
          {
            value: 0,
            median: 0,
            p_below: 0,
            quantiles: { "0.1": 0 },
            private: "omit-step",
          },
          { value: 1.23456789, p_above: null },
        ],
        private: "omit-answer",
      },
      text: {
        type: "text",
        value: null,
        guess: "é𐐀",
        span: [2, 8],
        p_null: 0,
        confidence: null,
        steps: "omit-wrong-type",
      },
      number: {
        type: "number",
        value: 0,
        guess: 0,
        p_null: null,
        confidence: 0,
      },
      date: { type: "date", value: "2026-10-23" },
      time: { type: "time", value: "12:34:56.123456+02:00" },
      datetime: { type: "datetime", value: "2026-10-23T12:34:56+02:00" },
      duration: { type: "duration", value: 1.23456789, unit: "days" },
      list: { type: "list", value: [], spans: [], confidence: 0 },
      estimate: {
        type: "estimate",
        value: "2026-11-01",
        median: "2026-11-01",
        quantiles: { "0.9": "2026-12-01", "0.1": "2026-10-01" },
      },
    };
    const response = {
      model: "clairic",
      answers,
      state_text: "processed",
      truncated: false,
      usage: {
        input_tokens: 12,
        output_tokens: 0,
        total_tokens: 15,
        passes: 7,
        state_tokens: 4,
        schema_tokens: 8,
      },
    };
    const params = {
      state: { text: "original é𐐀" },
      fields,
      options: {
        include_quantiles: false,
        return_state_text: true,
        secret: "omit-option",
      },
      private: "omit-request",
    };
    const run = vi.fn(async (..._args: unknown[]) => response);
    const ai = wrapWorkersAI({ run });
    expect(await ai.run("@cf/cloudflare/clairic", params)).toBe(response);
    expect(run).toHaveBeenCalledExactlyOnceWith(
      "@cf/cloudflare/clairic",
      params,
    );
    const [span] = (await logger.drain()) as LoggingEvent[];
    const { private: _fieldPrivate, ...textField } = fields.text;
    const { private: _answerPrivate, steps, ...forecast } = answers.forecast;
    const { private: _stepPrivate, ...firstStep } = steps[0];
    const { steps: _wrongType, ...textAnswer } = answers.text;
    expect(span.input).toEqual({
      state: params.state,
      fields: Object.entries({ ...fields, text: textField }).map(
        ([id, field]) => ({ id, ...field }),
      ),
      options: { include_quantiles: false, return_state_text: true },
    });
    expect(span.output).toEqual({
      answers: Object.entries({
        ...answers,
        forecast: { ...forecast, steps: [firstStep, steps[1]] },
        text: textAnswer,
      }).map(([id, answer]) => ({ id, ...answer })),
      state_text: "processed",
      truncated: false,
    });
    expect(span.metrics).toMatchObject({
      prompt_tokens: 12,
      completion_tokens: 0,
      tokens: 15,
    });
    expect(span.metrics).not.toHaveProperty("passes");
    expect(span.metrics).not.toHaveProperty("time_to_first_token");
    expect(span).not.toHaveProperty("scores");
    expect(span).not.toHaveProperty("classifications");
    expect(JSON.stringify(span)).not.toContain("omit-");
  });

  it.each([undefined, { input_tokens: 4 }, { output_tokens: 0 }])(
    "does not fabricate extraction usage (%j)",
    async (usage) => {
      const ai = wrapWorkersAI({
        run: async (..._args: unknown[]) => ({ answers: {}, usage }),
      });
      await ai.run("@cf/cloudflare/clairic", {
        fields: { value: { type: "number" } },
      });
      const [span] = (await logger.drain()) as LoggingEvent[];
      expect(span.input).toEqual({
        state: null,
        fields: [{ id: "value", type: "number" }],
      });
      expect(span.metadata).toMatchObject({ model: "@cf/cloudflare/clairic" });
      expect(span.metrics).not.toHaveProperty("tokens");
      if (usage?.input_tokens === undefined)
        expect(span.metrics).not.toHaveProperty("prompt_tokens");
      if (usage?.output_tokens === undefined)
        expect(span.metrics).not.toHaveProperty("completion_tokens");
    },
  );

  it("retains unexpected JSON values in allowed extraction properties", async () => {
    const response = {
      answers: {
        weird: {
          type: "forecast",
          value: null,
          p10: { unexpected: true },
          steps: "unexpected",
        },
      },
    };
    const ai = wrapWorkersAI({ run: async (..._args: unknown[]) => response });
    expect(
      await ai.run("@cf/cloudflare/clairic", {
        fields: { weird: { type: "forecast", horizon: null } },
      }),
    ).toBe(response);
    const [span] = await logger.drain();
    expect(span).toMatchObject({
      output: { answers: [{ id: "weird", ...response.answers.weird }] },
    });
  });

  it.each([false, true])(
    "defers extraction image conversion and preserves the complete input on upload failure (%s)",
    async (fail) => {
      vi.stubEnv("BRAINTRUST_AUTO_CAPTURE_ATTACHMENTS", "true");
      const upload = vi
        .spyOn(Attachment.prototype, "upload")
        .mockResolvedValueOnce({ upload_status: "done" });
      if (fail) upload.mockRejectedValueOnce(new Error("upload failed"));
      else upload.mockResolvedValue({ upload_status: "done" });
      const ai = wrapWorkersAI({
        run: async (..._args: unknown[]) => ({
          answers: { color: { type: "text", value: null } },
        }),
      });
      const params = {
        fields: { color: { type: "text" } },
        images: [
          "data:image/png;base64,aGVsbG8=",
          { content_type: "image/png", base64: "aGVsbG8=" },
        ],
      };
      await ai.run("@cf/cloudflare/clairic", params);
      const [span] = await logger.drain();
      expect(upload).not.toHaveBeenCalled();
      expect(span).toMatchObject({ input: { state: null } });
      const converted = await new TypedAttachmentProcessor().process(span);
      expect(upload).toHaveBeenCalledTimes(2);
      if (fail) expect(converted).toBe(span);
      else {
        expect(JSON.stringify(converted)).not.toContain("aGVsbG8=");
        expect(JSON.stringify(converted)).toContain("braintrust_attachment");
      }
      expect(params.images[0]).toBe("data:image/png;base64,aGVsbG8=");
    },
  );

  it.each([
    "@cf/cloudflare/clef",
    "@cf/cloudflare/clef-flash",
    "@cf/cloudflare/clef-omni",
  ])("supports %s", async (model) => {
    const ai = wrapWorkersAI({ run: async (..._args: unknown[]) => result });
    await ai.run(model, input);
    expect(await logger.drain()).toHaveLength(1);
  });

  it.each([
    ["@cf/other/model", input, undefined],
    ["@cf/cloudflare/clef", { ...input, stream: true }, undefined],
    ["@cf/cloudflare/clef", input, { returnRawResponse: true }],
    ["@cf/cloudflare/clef", input, { websocket: true }],
    ["@cf/cloudflare/clef", input, { queueRequest: true }],
  ])("passes through untraced modes: %s %j %j", async (...args) => {
    const response = new Response("untouched");
    const promise = Promise.resolve(response);
    const run = vi.fn((..._args: unknown[]) => promise);
    const ai = wrapWorkersAI({ run });
    expect(ai.run(...args)).toBe(promise);
    expect(await (await promise).text()).toBe("untouched");
    expect(run).toHaveBeenCalledExactlyOnceWith(...args);
    expect(await logger.drain()).toHaveLength(0);
  });

  it("is inert when disabled or suppressed", async () => {
    const ai = wrapWorkersAI({ run: async (..._args: unknown[]) => result });
    await runWithAutoInstrumentationSuppressed(() =>
      ai.run("@cf/cloudflare/clef", input),
    );
    resetInstrumentationForTest();
    configureInstrumentation({ integrations: { workersAI: false } });
    await ai.run("@cf/cloudflare/clef", input);
    expect(await logger.drain()).toHaveLength(0);
  });

  it.each([false, true])(
    "preserves provider errors (sync=%s) and ends once",
    async (sync) => {
      const error = new Error("inference failed");
      const run = vi.fn((..._args: unknown[]) => {
        if (sync) throw error;
        return Promise.reject(error);
      });
      const ai = wrapWorkersAI({ run });
      await expect(async () =>
        ai.run("@cf/cloudflare/clef", input),
      ).rejects.toBe(error);
      const spans = await logger.drain();
      expect(run).toHaveBeenCalledOnce();
      expect(spans).toHaveLength(1);
      expect(spans[0]).toMatchObject({
        error: expect.stringContaining("inference failed"),
        metrics: { end: expect.any(Number) },
      });
    },
  );

  it("isolates concurrent parents across awaits and preserves child context", async () => {
    const ai = wrapWorkersAI({
      run: async (..._args: unknown[]) => {
        const before = currentSpan().id;
        await new Promise((resolve) => setTimeout(resolve, 1));
        expect(currentSpan().id).toBe(before);
        await traced(async () => {}, { name: "inside binding" });
        return result;
      },
    });
    await Promise.all(
      ["one", "two"].map((name) =>
        traced(() => ai.run("@cf/cloudflare/clef", input), { name }),
      ),
    );
    const spans = (await logger.drain()) as LoggingEvent[];
    const roots = spans.filter((s) =>
      ["one", "two"].includes(String(s.span_attributes?.name ?? "")),
    );
    const calls = spans.filter(
      (s) => s.span_attributes?.name === "workers_ai.run",
    );
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((s) => s.span_parents?.[0]))).toEqual(
      new Set(roots.map((s) => s.span_id)),
    );
    for (const call of calls)
      expect(
        spans.some(
          (s) =>
            s.span_attributes?.name === "inside binding" &&
            s.span_parents?.[0] === call.span_id,
        ),
      ).toBe(true);
  });

  it.each(["@cf/cloudflare/clef-omni", "@cf/cloudflare/clairic"])(
    "omits inline media by default for %s",
    async (model) => {
      vi.stubEnv("BRAINTRUST_AUTO_CAPTURE_ATTACHMENTS", "false");
      const params = {
        ...input,
        fields: { id: { type: "text" } },
        images: [{ content_type: "image/png", base64: "private-image" }],
        audio: ["data:audio/wav;base64,private-audio"],
        videos: [{ content_type: "video/mp4", base64: "private-video" }],
      };
      const ai = wrapWorkersAI({ run: async (..._args: unknown[]) => result });
      await ai.run(model, params);
      const spans = await logger.drain();
      const serialized = JSON.stringify(spans);
      for (const text of ["private-image", "private-audio", "private-video"])
        expect(serialized).not.toContain(text);
      expect(serialized).toContain("<omitted>");
      expect(params.images[0].base64).toBe("private-image");
    },
  );

  it("defers decision media uploads until export and captures all modalities when opted in", async () => {
    vi.stubEnv("BRAINTRUST_AUTO_CAPTURE_ATTACHMENTS", "true");
    const upload = vi
      .spyOn(Attachment.prototype, "upload")
      .mockResolvedValue({ upload_status: "done" });
    const ai = wrapWorkersAI({ run: async (..._args: unknown[]) => result });
    await ai.run("@cf/cloudflare/clef-omni", {
      ...input,
      images: [{ content_type: "image/png", base64: "aGVsbG8=" }],
      audio: ["data:audio/wav;base64,aGVsbG8="],
      videos: [{ content_type: "video/mp4", base64: "aGVsbG8=" }],
    });
    const [span] = await logger.drain();
    expect(upload).not.toHaveBeenCalled();
    const processed = await new TypedAttachmentProcessor().process(span);
    expect(upload).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(processed)).not.toContain("aGVsbG8=");
    expect(JSON.stringify(processed)).toContain("braintrust_attachment");
  });

  it("does not invent incomplete or invalid usage", async () => {
    const ai = wrapWorkersAI({
      run: async (..._args: unknown[]) => ({
        ...result,
        usage: { input_tokens: 10, output_tokens: NaN },
      }),
    });
    await ai.run("@cf/cloudflare/clef", input);
    const [span] = await logger.drain();
    expect(span).toMatchObject({ metrics: { prompt_tokens: 10 } });
    expect(span).not.toHaveProperty("metrics.completion_tokens");
    expect(span).not.toHaveProperty("metrics.tokens");
  });

  it("returns unsupported values and frozen methods unchanged", () => {
    expect(wrapWorkersAI(null)).toBeNull();
    const other = {};
    expect(wrapWorkersAI(other)).toBe(other);
    const frozen = Object.freeze({ run: () => Promise.resolve(result) });
    expect(wrapWorkersAI(frozen).run).toBe(frozen.run);
  });

  it("keeps run interception separate from aliases of the same method", async () => {
    const run = async (..._args: unknown[]) => result;
    const ai = wrapWorkersAI({ run, other: run });
    await ai.other("@cf/cloudflare/clef", input);
    await ai.run("@cf/cloudflare/clef", input);
    expect(await logger.drain()).toHaveLength(1);
  });
});
