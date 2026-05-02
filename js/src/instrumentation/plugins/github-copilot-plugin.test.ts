import { describe, expect, it } from "vitest";
import {
  GitHubCopilotPlugin,
  extractMetricsFromUsage,
} from "./github-copilot-plugin";

describe("extractMetricsFromUsage", () => {
  it("maps input/output tokens to standard metric keys", () => {
    const result = extractMetricsFromUsage({
      model: "gpt-4.1",
      inputTokens: 100,
      outputTokens: 50,
    });

    expect(result.metrics.prompt_tokens).toBe(100);
    expect(result.metrics.completion_tokens).toBe(50);
    expect(result.metrics.tokens).toBe(150);
  });

  it("maps cache tokens via Anthropic-style helpers", () => {
    const result = extractMetricsFromUsage({
      model: "gpt-4.1",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 20,
      cacheWriteTokens: 10,
    });

    expect(result.metrics.prompt_cached_tokens).toBe(20);
    expect(result.metrics.prompt_cache_creation_tokens).toBe(10);
    // finalizeAnthropicTokens includes cache tokens in prompt_tokens
    expect(result.metrics.prompt_tokens).toBe(130); // 100 + 20 + 10
    expect(result.metrics.tokens).toBe(180); // 130 + 50
  });

  it("maps reasoning tokens to both completion_reasoning_tokens and reasoning_tokens", () => {
    const result = extractMetricsFromUsage({
      model: "o4-mini",
      inputTokens: 50,
      outputTokens: 30,
      reasoningTokens: 15,
    });

    expect(result.metrics.completion_reasoning_tokens).toBe(15);
    expect(result.metrics.reasoning_tokens).toBe(15);
  });

  it("puts billing/perf fields in metadata, not metrics", () => {
    const result = extractMetricsFromUsage({
      model: "gpt-4.1",
      cost: 0.42,
      duration: 1234,
      ttftMs: 100,
      interTokenLatencyMs: 50,
      apiCallId: "chatcmpl-abc",
      providerCallId: "gh-req-id",
      interactionId: "capi-id",
      initiator: "sub-agent",
      reasoningEffort: "high",
    });

    expect(result.metadata["model"]).toBe("gpt-4.1");
    expect(result.metadata["github_copilot.cost"]).toBe(0.42);
    expect(result.metadata["github_copilot.duration_ms"]).toBe(1234);
    expect(result.metadata["github_copilot.time_to_first_token_ms"]).toBe(100);
    expect(result.metadata["github_copilot.intertoken_latency_ms"]).toBe(50);
    expect(result.metadata["github_copilot.api_call_id"]).toBe("chatcmpl-abc");
    expect(result.metadata["github_copilot.provider_call_id"]).toBe(
      "gh-req-id",
    );
    expect(result.metadata["github_copilot.interaction_id"]).toBe("capi-id");
    expect(result.metadata["github_copilot.initiator"]).toBe("sub-agent");
    expect(result.metadata["github_copilot.reasoning_effort"]).toBe("high");
  });

  it("includes copilotUsage and quotaSnapshots as raw metadata passthrough", () => {
    const copilotUsage = {
      tokenDetails: [
        { batchSize: 1, costPerBatch: 0.1, tokenCount: 10, tokenType: "input" },
      ],
      totalNanoAiu: 1000,
    };
    const quotaSnapshots = {
      "premium-requests": {
        entitlementRequests: 300,
        isUnlimitedEntitlement: false,
        overage: 0,
        usedRequests: 42,
        remainingPercentage: 0.86,
      },
    };

    const result = extractMetricsFromUsage({
      model: "gpt-4.1",
      copilotUsage,
      quotaSnapshots,
    });

    expect(result.metadata["github_copilot.copilot_usage"]).toBe(copilotUsage);
    expect(result.metadata["github_copilot.quota_snapshots"]).toBe(
      quotaSnapshots,
    );
  });

  it("omits undefined optional metadata fields", () => {
    const result = extractMetricsFromUsage({ model: "gpt-4.1" });

    expect(result.metadata["github_copilot.cost"]).toBeUndefined();
    expect(result.metadata["github_copilot.duration_ms"]).toBeUndefined();
    expect(result.metadata["github_copilot.copilot_usage"]).toBeUndefined();
  });

  it("handles missing token counts without throwing", () => {
    const result = extractMetricsFromUsage({ model: "gpt-4.1" });

    expect(result.metrics.prompt_tokens).toBe(0);
    expect(result.metrics.completion_tokens).toBeUndefined();
    expect(result.metrics.tokens).toBe(0);
  });
});

describe("GitHubCopilotPlugin lifecycle", () => {
  it("enables without throwing", () => {
    const plugin = new GitHubCopilotPlugin();
    expect(() => plugin.enable()).not.toThrow();
    plugin.disable();
  });

  it("disables without throwing", () => {
    const plugin = new GitHubCopilotPlugin();
    plugin.enable();
    expect(() => plugin.disable()).not.toThrow();
  });

  it("enable is idempotent", () => {
    const plugin = new GitHubCopilotPlugin();
    plugin.enable();
    expect(() => plugin.enable()).not.toThrow();
    plugin.disable();
  });

  it("disable is idempotent", () => {
    const plugin = new GitHubCopilotPlugin();
    plugin.enable();
    plugin.disable();
    expect(() => plugin.disable()).not.toThrow();
  });

  it("can be re-enabled after disable", () => {
    const plugin = new GitHubCopilotPlugin();
    plugin.enable();
    plugin.disable();
    expect(() => plugin.enable()).not.toThrow();
    plugin.disable();
  });
});
