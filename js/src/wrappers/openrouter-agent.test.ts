import { afterEach, describe, expect, it, vi } from "vitest";
import { wrapOpenRouterAgent } from "./openrouter-agent";
import { openRouterAgentChannels } from "../instrumentation/plugins/openrouter-agent-channels";

describe("wrapOpenRouterAgent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the original value and warns for unsupported inputs", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const input = { notCallModel: true };

    expect(wrapOpenRouterAgent(input as object)).toBe(input);
    expect(warnSpy).toHaveBeenCalledWith(
      "Unsupported OpenRouter Agent library. Not wrapping.",
    );
  });

  it("invokes the callModel hook and clones the request", () => {
    const traceSpy = vi.spyOn(openRouterAgentChannels.callModel, "invoke");
    const sdk = {
      name: "agent-sdk",
      callModel(request: Record<string, unknown>, options?: unknown) {
        return {
          options,
          request,
          thisName: this.name,
        };
      },
    };
    const wrapped = wrapOpenRouterAgent(sdk);

    const request = { input: "hello", model: "openai/gpt-4.1-mini" };
    const result = wrapped.callModel(request);

    expect(traceSpy).toHaveBeenCalledTimes(1);
    const callArgs = traceSpy.mock.calls[0]![2];
    expect(callArgs[0]).toMatchObject(request);
    expect(callArgs[0]).not.toBe(request);
    expect(result).toMatchObject({
      options: undefined,
      request: callArgs[0],
      thisName: "agent-sdk",
    });
  });
});
