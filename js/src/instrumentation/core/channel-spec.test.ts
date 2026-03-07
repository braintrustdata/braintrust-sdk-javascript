import { describe, expect, it } from "vitest";
import { channel } from "./channel-spec";

describe("channel", () => {
  it("preserves the explicit channel name and fullName", () => {
    const typedChannel = channel({
      name: "chat.completions.create",
      fullName: "orchestrion:openai:chat.completions.create",
      kind: "async",
    });

    expect(typedChannel.name).toBe("chat.completions.create");
    expect(typedChannel.fullName).toBe(
      "orchestrion:openai:chat.completions.create",
    );
  });
});
