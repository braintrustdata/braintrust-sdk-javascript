import {
  JSONAttachment,
  _exportsForTestingOnly,
  BaseAttachment,
} from "./logger";
import { describe, expect, it } from "vitest";

const { extractAttachments } = _exportsForTestingOnly;

describe("JSONAttachment", () => {
  it("should create an attachment from JSON data", async () => {
    const testData = {
      foo: "bar",
      nested: {
        array: [1, 2, 3],
        bool: true,
      },
    };

    const attachment = new JSONAttachment(testData);

    expect(attachment.reference.type).toBe("braintrust_attachment");
    expect(attachment.reference.filename).toBe("data.json");
    expect(attachment.reference.content_type).toBe("application/json");
    expect(attachment.reference.key).toBeDefined();

    // Verify the data can be retrieved
    const blob = await attachment.data();
    const text = await blob.text();
    const parsed = JSON.parse(text);
    expect(parsed).toEqual(testData);
  });

  it("should handle custom filename", () => {
    const attachment = new JSONAttachment(
      { test: "data" },
      { filename: "custom.json" },
    );

    expect(attachment.reference.filename).toBe("custom.json");
  });

  it("should defer to the dataset pipeline hook when installed", () => {
    const globalWithHook = globalThis as typeof globalThis & {
      __BT_DATASET_PIPELINE_DEFER_JSON_ATTACHMENT__?: (
        data: unknown,
        options?: { filename?: string; pretty?: boolean },
      ) => object;
    };
    const previous = globalWithHook.__BT_DATASET_PIPELINE_DEFER_JSON_ATTACHMENT__;
    try {
      globalWithHook.__BT_DATASET_PIPELINE_DEFER_JSON_ATTACHMENT__ = (
        data,
        options,
      ) => {
        const reference = {
          type: "braintrust_deferred_attachment",
          kind: "json",
          filename: options?.filename,
          content_type: "application/json",
          pretty: options?.pretty,
          data,
        };
        return { reference };
      };

      const attachment = new JSONAttachment(
        { test: "data" },
        { filename: "trace.json", pretty: true },
      );

      expect(attachment.reference).toEqual({
        type: "braintrust_deferred_attachment",
        kind: "json",
        filename: "trace.json",
        content_type: "application/json",
        pretty: true,
        data: { test: "data" },
      });
    } finally {
      globalWithHook.__BT_DATASET_PIPELINE_DEFER_JSON_ATTACHMENT__ = previous;
    }
  });

  it("should pretty print when requested", async () => {
    const testData = { a: 1, b: 2 };
    const attachment = new JSONAttachment(testData, { pretty: true });

    const blob = await attachment.data();
    const text = await blob.text();
    expect(text).toBe('{\n  "a": 1,\n  "b": 2\n}');
  });

  it("should handle large transcript scenario", () => {
    const largeTranscript = Array.from({ length: 1000 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message ${i}`,
      timestamp: Date.now() + i,
    }));

    const attachment = new JSONAttachment(largeTranscript, {
      filename: "transcript.json",
    });

    expect(attachment.reference.filename).toBe("transcript.json");
    expect(attachment.reference.content_type).toBe("application/json");
  });

  it("should handle arrays and primitives", async () => {
    const arrayData = [1, 2, 3, 4, 5];
    const attachment = new JSONAttachment(arrayData);

    const blob = await attachment.data();
    const text = await blob.text();
    expect(JSON.parse(text)).toEqual(arrayData);
  });

  it("should integrate with logger patterns", () => {
    // Example of the intended usage pattern
    const logData = {
      input: {
        type: "nameOfPrompt",
        transcript: new JSONAttachment([
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi there!" },
        ]),
        configValue1: 123,
        configValue2: true,
      },
      output: [{ type: "text", value: "Generated response" }],
      metadata: {
        sessionId: "123",
        userId: "456",
        renderedPrompt: new JSONAttachment(
          "This is a very long prompt template...",
          { filename: "prompt.json" },
        ),
      },
    };

    // Verify the structure contains JSONAttachment instances
    expect(logData.input.transcript).toBeInstanceOf(JSONAttachment);
    expect(logData.metadata.renderedPrompt).toBeInstanceOf(JSONAttachment);
  });

  it("should handle null and undefined values", async () => {
    const testData = {
      nullValue: null,
      undefinedValue: undefined,
      nested: {
        alsoNull: null,
      },
    };

    const attachment = new JSONAttachment(testData);
    const blob = await attachment.data();
    const text = await blob.text();
    const parsed = JSON.parse(text);

    // undefined should be stripped by JSON.stringify
    expect(parsed).toEqual({
      nullValue: null,
      nested: {
        alsoNull: null,
      },
    });
  });

  it("should handle special characters and unicode", async () => {
    const testData = {
      emoji: "🚀 Hello World 🌍",
      special: "quotes \"and\" 'apostrophes'",
      unicode: "Iñtërnâtiônàlizætiøn",
      newlines: "line1\nline2\ttabbed",
    };

    const attachment = new JSONAttachment(testData);
    const blob = await attachment.data();
    const text = await blob.text();
    const parsed = JSON.parse(text);

    expect(parsed).toEqual(testData);
  });

  it("should work with extractAttachments", () => {
    const jsonAttachment = new JSONAttachment(
      { foo: "bar" },
      { filename: "test.json" },
    );

    const event = {
      input: {
        data: jsonAttachment,
      },
    };

    const attachments: BaseAttachment[] = [];
    extractAttachments(event, attachments);

    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toBe(jsonAttachment);
    expect(event.input.data).toEqual(jsonAttachment.reference);
  });

  it("should handle nested JSONAttachments in arrays", () => {
    const attachment1 = new JSONAttachment({ id: 1 });
    const attachment2 = new JSONAttachment({ id: 2 });

    const event = {
      messages: [attachment1, "text", attachment2],
    };

    const attachments: BaseAttachment[] = [];
    extractAttachments(event, attachments);

    expect(attachments).toHaveLength(2);
    expect(attachments[0]).toBe(attachment1);
    expect(attachments[1]).toBe(attachment2);
    expect(event.messages[0]).toEqual(attachment1.reference);
    expect(event.messages[1]).toBe("text");
    expect(event.messages[2]).toEqual(attachment2.reference);
  });

  it("should create unique keys for each attachment", () => {
    const attachment1 = new JSONAttachment({ test: 1 });
    const attachment2 = new JSONAttachment({ test: 2 });

    expect(attachment1.reference.key).toBeDefined();
    expect(attachment2.reference.key).toBeDefined();
    expect(attachment1.reference.key).not.toBe(attachment2.reference.key);
  });

  it("should handle empty objects and arrays", async () => {
    const emptyObject = new JSONAttachment({});
    const emptyArray = new JSONAttachment([]);

    const objectBlob = await emptyObject.data();
    const objectText = await objectBlob.text();
    expect(JSON.parse(objectText)).toEqual({});

    const arrayBlob = await emptyArray.data();
    const arrayText = await arrayBlob.text();
    expect(JSON.parse(arrayText)).toEqual([]);
  });

  it("should handle deeply nested structures", async () => {
    const deepData = {
      level1: {
        level2: {
          level3: {
            level4: {
              level5: {
                value: "deep",
              },
            },
          },
        },
      },
    };

    const attachment = new JSONAttachment(deepData);
    const blob = await attachment.data();
    const text = await blob.text();
    const parsed = JSON.parse(text);

    expect(parsed).toEqual(deepData);
  });

  it("should handle numbers including special values", async () => {
    const testData = {
      integer: 42,
      float: 3.14159,
      negative: -100,
      zero: 0,
      // Note: Infinity, -Infinity, and NaN are not valid JSON
      // and will be converted to null by JSON.stringify
    };

    const attachment = new JSONAttachment(testData);
    const blob = await attachment.data();
    const text = await blob.text();
    const parsed = JSON.parse(text);

    expect(parsed).toEqual(testData);
  });
});
