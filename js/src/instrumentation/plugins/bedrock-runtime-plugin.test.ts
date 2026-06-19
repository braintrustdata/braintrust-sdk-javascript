import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { _exportsForTestingOnly, initLogger } from "../../logger";
import { configureNode } from "../../node/config";
import { smithyCoreChannels } from "./bedrock-runtime-channels";
import {
  aggregateBedrockConverseStreamChunks,
  parseBedrockRuntimeMetrics,
} from "./bedrock-runtime-plugin";

try {
  configureNode();
} catch {
  // Best-effort initialization for test environments.
}

class ConverseCommand {
  constructor(public input: Record<string, unknown>) {}
}

describe("BedrockRuntimePlugin", () => {
  let backgroundLogger: ReturnType<
    typeof _exportsForTestingOnly.useTestBackgroundLogger
  >;

  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
  });

  beforeEach(() => {
    backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({
      projectName: "bedrock-runtime-plugin.test.ts",
      projectId: "test-project-id",
    });
  });

  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
  });

  it("traces promise-style Smithy send events and ignores callback overloads", async () => {
    const tracingChannel = smithyCoreChannels.clientSend.tracingChannel();

    await smithyCoreChannels.clientSend.tracePromise(
      async () => ({
        output: {
          message: {
            role: "assistant",
            content: [{ text: "OK" }],
          },
        },
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
        },
      }),
      {
        arguments: [
          new ConverseCommand({
            messages: [{ role: "user", content: [{ text: "OK" }] }],
            modelId: "us.amazon.nova-lite-v1:0",
          }),
        ],
      },
    );

    const callbackEvent: any = {
      arguments: [
        new ConverseCommand({
          messages: [{ role: "user", content: [{ text: "ignored" }] }],
          modelId: "us.amazon.nova-lite-v1:0",
        }),
        () => {},
      ],
    };
    tracingChannel.start.publish(callbackEvent);
    callbackEvent.result = {
      output: {
        message: {
          role: "assistant",
          content: [{ text: "ignored" }],
        },
      },
    };
    tracingChannel.asyncEnd.publish(callbackEvent);

    const spans = await backgroundLogger.drain();
    expect(spans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          span_attributes: expect.objectContaining({
            name: "bedrock.converse",
          }),
          output: {
            role: "assistant",
            content: [{ text: "OK" }],
          },
        }),
      ]),
    );
    expect(spans).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          output: {
            role: "assistant",
            content: [{ text: "ignored" }],
          },
        }),
      ]),
    );
  });
});

describe("parseBedrockRuntimeMetrics", () => {
  it("maps Bedrock usage and latency metrics to Braintrust metrics", () => {
    expect(
      parseBedrockRuntimeMetrics(
        {
          cacheReadInputTokens: 3,
          cacheWriteInputTokens: 2,
          inputTokens: 10,
          outputTokens: 4,
          totalTokens: 14,
        },
        {
          latencyMs: 321,
        },
      ),
    ).toEqual({
      completion_tokens: 4,
      latency_ms: 321,
      prompt_cache_creation_tokens: 2,
      prompt_cached_tokens: 3,
      prompt_tokens: 10,
      tokens: 14,
    });
  });

  it("returns an empty object for unknown values", () => {
    expect(parseBedrockRuntimeMetrics(undefined, undefined)).toEqual({});
    expect(parseBedrockRuntimeMetrics({}, {})).toEqual({});
  });
});

describe("aggregateBedrockConverseStreamChunks", () => {
  it("aggregates text, stop reason, and metrics from Converse stream events", () => {
    expect(
      aggregateBedrockConverseStreamChunks([
        {
          messageStart: {
            role: "assistant",
          },
        },
        {
          contentBlockDelta: {
            contentBlockIndex: 0,
            delta: {
              text: "ST",
            },
          },
        },
        {
          contentBlockDelta: {
            contentBlockIndex: 0,
            delta: {
              text: "REAM",
            },
          },
        },
        {
          messageStop: {
            stopReason: "end_turn",
          },
        },
        {
          metadata: {
            metrics: {
              latencyMs: 456,
            },
            usage: {
              inputTokens: 6,
              outputTokens: 1,
              totalTokens: 7,
            },
          },
        },
      ]),
    ).toEqual({
      metadata: {
        stopReason: "end_turn",
      },
      metrics: {
        completion_tokens: 1,
        latency_ms: 456,
        prompt_tokens: 6,
        tokens: 7,
      },
      output: {
        content: [
          {
            text: "STREAM",
          },
        ],
        role: "assistant",
      },
    });
  });

  it("drops prototype pollution keys from sanitized Bedrock objects", () => {
    const delta = JSON.parse(`{
      "__proto__": { "pollutedFromDelta": true },
      "constructor": { "prototype": { "pollutedFromConstructor": true } },
      "extra": {
        "__proto__": { "pollutedFromNestedDelta": true },
        "keep": true
      },
      "prototype": { "pollutedFromPrototype": true },
      "text": "OK"
    }`);
    const maliciousAdditionalModelResponseFields = JSON.parse(`{
      "__proto__": { "pollutedFromMetadata": true },
      "constructor": { "prototype": { "pollutedFromConstructor": true } },
      "prototype": { "pollutedFromPrototype": true },
      "safe": {
        "__proto__": { "pollutedFromNestedMetadata": true },
        "keep": true
      }
    }`);

    expect(Object.getOwnPropertyDescriptor(delta, "__proto__")).toBeDefined();
    expect(
      Object.getOwnPropertyDescriptor(
        maliciousAdditionalModelResponseFields,
        "__proto__",
      ),
    ).toBeDefined();

    const result = aggregateBedrockConverseStreamChunks([
      {
        contentBlockDelta: {
          contentBlockIndex: 0,
          delta,
        },
      },
      {
        messageStop: {
          additionalModelResponseFields: maliciousAdditionalModelResponseFields,
        },
      },
    ]);

    const content = (
      result.output as { content: Array<Record<string, unknown>> }
    ).content[0];
    const extra = content.extra as Record<string, unknown>;
    const metadata = result.metadata as Record<string, unknown>;
    const sanitizedAdditionalModelResponseFields =
      metadata.additionalModelResponseFields as Record<string, unknown>;
    const safe = sanitizedAdditionalModelResponseFields.safe as Record<
      string,
      unknown
    >;

    expect(content.text).toBe("OK");
    expect(extra.keep).toBe(true);
    expect(safe.keep).toBe(true);

    for (const value of [
      content,
      extra,
      sanitizedAdditionalModelResponseFields,
      safe,
      {},
    ]) {
      expect("pollutedFromDelta" in value).toBe(false);
      expect("pollutedFromMetadata" in value).toBe(false);
      expect("pollutedFromNestedDelta" in value).toBe(false);
      expect("pollutedFromNestedMetadata" in value).toBe(false);
      expect("pollutedFromConstructor" in value).toBe(false);
      expect("pollutedFromPrototype" in value).toBe(false);
      expect(Object.getOwnPropertyDescriptor(value, "__proto__")).toBe(
        undefined,
      );
      expect(Object.getOwnPropertyDescriptor(value, "constructor")).toBe(
        undefined,
      );
      expect(Object.getOwnPropertyDescriptor(value, "prototype")).toBe(
        undefined,
      );
    }
  });
});
