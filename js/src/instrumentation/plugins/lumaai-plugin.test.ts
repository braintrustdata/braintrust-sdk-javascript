import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { _exportsForTestingOnly, initLogger } from "../../logger";
import { configureNode } from "../../node/config";
import { runWithAutoInstrumentationSuppressed } from "../auto-instrumentation-suppression";
import { configureInstrumentation, registry } from "../registry";
import { lumaAIChannels } from "./lumaai-interceptors";

configureNode();

describe("Luma AI instrumentation", () => {
  let backgroundLogger: ReturnType<
    typeof _exportsForTestingOnly.useTestBackgroundLogger
  >;
  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
  });
  beforeEach(() => {
    registry.disable();
    configureInstrumentation({ integrations: { lumaai: true } });
    registry.enable();
    backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({
      projectName: "lumaai-plugin.test.ts",
      projectId: "test-project-id",
    });
  });
  afterEach(() => {
    registry.disable();
    configureInstrumentation({ integrations: { lumaai: true } });
    registry.enable();
    _exportsForTestingOnly.clearTestBackgroundLogger();
    vi.restoreAllMocks();
  });

  it("traces text/image-to-video creation and preserves promise identity, receiver and arguments", async () => {
    const body = {
      prompt: "A calm lake",
      keyframes: {
        frame0: { type: "image", url: "https://example.com/lake.png" },
      },
      concepts: [{ key: "static" }],
      model: "ray-2",
      duration: "5s",
      resolution: "540p",
      aspect_ratio: "16:9",
      loop: false,
      callback_url: "https://example.com/private-token",
    };
    const output = { id: "generation-1", state: "queued", model: "ray-2" };
    const promise = Object.assign(Promise.resolve(output), {
      withResponse: () => "response-helper",
    });
    const receiver = {};
    const options = { headers: { authorization: "secret" } };
    const target = vi.fn(function (this: unknown, ..._args: unknown[]) {
      expect(this).toBe(receiver);
      return promise;
    });
    const result = lumaAIChannels.generationsCreate.invoke(
      target,
      receiver,
      [body, options],
      {},
    );
    expect(result).toBe(promise);
    expect(result.withResponse()).toBe("response-helper");
    expect(await result).toBe(output);
    expect(target).toHaveBeenCalledExactlyOnceWith(body, options);
    const spans = await backgroundLogger.drain();
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      span_attributes: { name: "lumaai.generations.create", type: "llm" },
      input: {
        prompt: body.prompt,
        keyframes: body.keyframes,
        concepts: body.concepts,
      },
      metadata: {
        provider: "lumaai",
        model: "ray-2",
        duration: "5s",
        resolution: "540p",
        aspect_ratio: "16:9",
        loop: false,
      },
      output: { id: "generation-1", state: "queued" },
      context: { span_origin: { instrumentation: { name: "lumaai" } } },
      metrics: { start: expect.any(Number), end: expect.any(Number) },
    });
    expect(JSON.stringify(spans)).not.toContain("secret");
    expect(JSON.stringify(spans)).not.toContain("private-token");
  });

  it("records each poll including failed generation responses", async () => {
    for (const output of [
      { id: "generation-1", state: "dreaming" },
      {
        id: "generation-1",
        state: "completed",
        assets: { video: "https://example.com/video.mp4" },
      },
      {
        id: "generation-2",
        state: "failed",
        failure_reason: "Generation failed",
      },
    ]) {
      expect(
        await lumaAIChannels.generationsGet.invoke(
          () => Promise.resolve(output),
          undefined,
          [output.id],
          {},
        ),
      ).toBe(output);
    }
    const spans = await backgroundLogger.drain();
    expect(spans).toHaveLength(3);
    expect(spans[1]).toMatchObject({
      span_attributes: { name: "lumaai.generations.get", type: "tool" },
      input: { id: "generation-1" },
      output: {
        state: "completed",
        assets: { video: "https://example.com/video.mp4" },
      },
    });
    expect(spans[2]).toMatchObject({
      error: "Generation failed",
      output: { state: "failed" },
      metrics: { end: expect.any(Number) },
    });
  });

  it("preserves synchronous and asynchronous errors and ends both spans", async () => {
    const error = new Error("Luma request failed");
    expect(() =>
      lumaAIChannels.generationsCreate.invoke(
        () => {
          throw error;
        },
        undefined,
        [{}],
        {},
      ),
    ).toThrow(error);
    await expect(
      lumaAIChannels.generationsGet.invoke(
        () => Promise.reject(error),
        undefined,
        ["id"],
        {},
      ),
    ).rejects.toBe(error);
    const spans = await backgroundLogger.drain();
    expect(spans).toHaveLength(2);
    for (const span of spans)
      expect(span).toMatchObject({
        error: expect.stringContaining("Luma request failed"),
        metrics: { end: expect.any(Number) },
      });
  });

  it("supports suppression, disabling and re-enabling without duplicate spans", async () => {
    const call = () =>
      lumaAIChannels.generationsGet.invoke(
        () => Promise.resolve({ id: "id" }),
        undefined,
        ["id"],
        {},
      );
    await runWithAutoInstrumentationSuppressed(call);
    registry.disable();
    configureInstrumentation({ integrations: { lumaai: false } });
    registry.enable();
    await call();
    expect(await backgroundLogger.drain()).toHaveLength(0);
    registry.disable();
    configureInstrumentation({ integrations: { lumaai: true } });
    registry.enable();
    await call();
    expect(await backgroundLogger.drain()).toHaveLength(1);
  });

  it("does not let extraction failures change provider behavior", async () => {
    const target = vi.fn(() => Promise.resolve({ id: "id" }));
    await lumaAIChannels.generationsCreate.invoke(
      target,
      undefined,
      [
        {
          get prompt() {
            throw new Error("bad getter");
          },
        },
      ],
      {},
    );
    expect(target).toHaveBeenCalledTimes(1);
  });
});
