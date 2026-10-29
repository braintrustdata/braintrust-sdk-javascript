import { describe, expect, it } from "vite-plus/test";
import { buildStartSpanArgs } from "./tracing-utils";

describe("buildStartSpanArgs", () => {
  const config = {
    name: "fallback-name",
    type: "llm",
  };

  it("uses span_info from the channel context when present", () => {
    const result = buildStartSpanArgs(config, {
      arguments: [{}],
      span_info: {
        name: "context-name",
        spanAttributes: { foo: "bar" },
        metadata: { source: "context" },
      },
    });

    expect(result).toEqual({
      name: "context-name",
      spanAttributes: {
        type: "llm",
        foo: "bar",
      },
      spanInfoMetadata: { source: "context" },
    });
  });

  it("falls back to span_info on the first argument", () => {
    const result = buildStartSpanArgs(config, {
      arguments: [
        {
          span_info: {
            name: "arg-name",
            spanAttributes: { baz: 1 },
            metadata: { source: "argument" },
          },
        },
      ],
    });

    expect(result).toEqual({
      name: "arg-name",
      spanAttributes: {
        type: "llm",
        baz: 1,
      },
      spanInfoMetadata: { source: "argument" },
    });
  });
});
