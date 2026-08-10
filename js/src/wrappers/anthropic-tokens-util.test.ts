import { describe, expect, it } from "vitest";
import {
  finalizeAnthropicTokens,
  toNumericMetrics,
} from "./anthropic-tokens-util";

describe("finalizeAnthropicTokens", () => {
  it("includes legacy aggregate cache creation tokens", () => {
    expect(
      finalizeAnthropicTokens({
        completion_tokens: 48,
        prompt_cache_creation_tokens: 199,
        prompt_cached_tokens: 24_243,
        prompt_tokens: 8,
      }),
    ).toMatchObject({
      prompt_tokens: 24_450,
      tokens: 24_498,
    });
  });

  it("uses TTL cache creation tokens instead of the legacy aggregate", () => {
    const metrics = finalizeAnthropicTokens({
      completion_tokens: 48,
      prompt_cache_creation_1h_tokens: 0,
      prompt_cache_creation_5m_tokens: 199,
      prompt_cache_creation_tokens: 999,
      prompt_cached_tokens: 24_243,
      prompt_tokens: 8,
    });

    expect(metrics).toMatchObject({
      prompt_tokens: 24_450,
      tokens: 24_498,
    });
    expect(metrics.prompt_cache_creation_tokens).toBeUndefined();
  });

  it("drops the aggregate for callers that keep the returned object", () => {
    const raw = {
      completion_tokens: 48,
      prompt_cache_creation_5m_tokens: 199,
      prompt_cache_creation_tokens: 199,
      prompt_tokens: 8,
    };

    // Merging the result back over the input would keep both representations,
    // which Anthropic spans must never carry.
    expect(
      Object.assign({ ...raw }, finalizeAnthropicTokens(raw)),
    ).toHaveProperty("prompt_cache_creation_tokens");
    expect(finalizeAnthropicTokens(raw)).not.toHaveProperty(
      "prompt_cache_creation_tokens",
    );
  });
});

describe("toNumericMetrics", () => {
  it("drops unset metrics", () => {
    expect(
      toNumericMetrics({
        completion_tokens: 0,
        prompt_cache_creation_tokens: undefined,
        prompt_tokens: 8,
      }),
    ).toEqual({ completion_tokens: 0, prompt_tokens: 8 });
  });
});
