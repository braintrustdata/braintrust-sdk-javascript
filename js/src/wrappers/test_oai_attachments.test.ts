import { describe, it, expect, beforeEach } from "vitest";
import OpenAI from "openai";
import { wrapOpenAI } from "./oai";
import { Attachment, initLogger } from "../logger";

const PROJECT_NAME = "test-project-openai-attachment-processing";
const TEST_MODEL = "gpt-4o-mini";

describe("OpenAI attachment processing", () => {
  beforeEach(() => {
    initLogger({
      projectName: PROJECT_NAME,
      apiKey: "test-key",
    });
  });

  it("should convert image data URLs to Attachment objects", async () => {
    const base64Image =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
    const dataUrl = `data:image/png;base64,${base64Image}`;

    const client = wrapOpenAI(new OpenAI({ apiKey: "test-key" }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockCreate = async (params: any) => {
      const content = params.messages[0].content;
      expect(content).toBeDefined();
      expect(content[1].type).toBe("image_url");

      const imageUrlValue = content[1].image_url.url;
      expect(imageUrlValue).toBeInstanceOf(Attachment);
      expect(imageUrlValue.contentType).toBe("image/png");
      expect(imageUrlValue.filename).toBe("image.png");

      return {
        choices: [{ message: { content: "This is a red image." } }],
        usage: { total_tokens: 100, prompt_tokens: 50, completion_tokens: 50 },
      };
    };

    const originalCreate = client.chat.completions.create;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions
    client.chat.completions.create = mockCreate as any;

    const response = await client.chat.completions.create({
      model: TEST_MODEL,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What color is this image?" },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
    });

    expect(response).toBeDefined();
    expect(response.choices[0].message.content).toContain("red");

    client.chat.completions.create = originalCreate;
  });

  it("should convert PDF data URLs with filename to Attachment objects using provided filename", async () => {
    const base64Pdf =
      "JVBERi0xLjAKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PmVuZG9iagoyIDAgb2JqCjw8L1R5cGUvUGFnZXMvS2lkc1szIDAgUl0vQ291bnQgMT4+ZW5kb2JqCjMgMCBvYmoKPDwvVHlwZS9QYWdlL01lZGlhQm94WzAgMCA2MTIgNzkyXT4+ZW5kb2JqCnhyZWYKMCA0CjAwMDAwMDAwMDAgNjU1MzUgZg0KMDAwMDAwMDAxMCAwMDAwMCBuDQowMDAwMDAwMDUzIDAwMDAwIG4NCjAwMDAwMDAxMDIgMDAwMDAgbg0KdHJhaWxlcgo8PC9TaXplIDQvUm9vdCAxIDAgUj4+CnN0YXJ0eHJlZgoxNDkKJUVPRg==";
    const dataUrl = `data:application/pdf;base64,${base64Pdf}`;

    const client = wrapOpenAI(new OpenAI({ apiKey: "test-key" }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockCreate = async (params: any) => {
      const content = params.messages[0].content;
      expect(content).toBeDefined();
      expect(content[1].type).toBe("file");

      const fileDataValue = content[1].file.file_data;
      expect(fileDataValue).toBeInstanceOf(Attachment);
      expect(fileDataValue.contentType).toBe("application/pdf");
      expect(fileDataValue.filename).toBe("test.pdf");

      return {
        choices: [{ message: { content: "This is a PDF document." } }],
        usage: { total_tokens: 100, prompt_tokens: 50, completion_tokens: 50 },
      };
    };

    const originalCreate = client.chat.completions.create;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions
    client.chat.completions.create = mockCreate as any;

    const response = await client.chat.completions.create({
      model: TEST_MODEL,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What type of document is this?" },
            {
              type: "file",
              file: {
                file_data: dataUrl,
                filename: "test.pdf",
              },
            },
          ],
        },
      ],
    });

    expect(response).toBeDefined();

    client.chat.completions.create = originalCreate;
  });

  it("should use fallback filename when no filename is provided", async () => {
    const base64Pdf =
      "JVBERi0xLjAKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PmVuZG9iagoyIDAgb2JqCjw8L1R5cGUvUGFnZXMvS2lkc1szIDAgUl0vQ291bnQgMT4+ZW5kb2JqCjMgMCBvYmoKPDwvVHlwZS9QYWdlL01lZGlhQm94WzAgMCA2MTIgNzkyXT4+ZW5kb2JqCnhyZWYKMCA0CjAwMDAwMDAwMDAgNjU1MzUgZg0KMDAwMDAwMDAxMCAwMDAwMCBuDQowMDAwMDAwMDUzIDAwMDAwIG4NCjAwMDAwMDAxMDIgMDAwMDAgbg0KdHJhaWxlcgo8PC9TaXplIDQvUm9vdCAxIDAgUj4+CnN0YXJ0eHJlZgoxNDkKJUVPRg==";
    const dataUrl = `data:application/pdf;base64,${base64Pdf}`;

    const client = wrapOpenAI(new OpenAI({ apiKey: "test-key" }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockCreate = async (params: any) => {
      const content = params.messages[0].content;
      expect(content).toBeDefined();
      expect(content[1].type).toBe("file");

      const fileDataValue = content[1].file.file_data;
      expect(fileDataValue).toBeInstanceOf(Attachment);
      expect(fileDataValue.contentType).toBe("application/pdf");
      expect(fileDataValue.filename).toBe("document.pdf");

      return {
        choices: [{ message: { content: "This is a PDF document." } }],
        usage: { total_tokens: 100, prompt_tokens: 50, completion_tokens: 50 },
      };
    };

    const originalCreate = client.chat.completions.create;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions
    client.chat.completions.create = mockCreate as any;

    const response = await client.chat.completions.create({
      model: TEST_MODEL,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What type of document is this?" },
            {
              type: "file",
              file: {
                file_data: dataUrl,
              },
            },
          ],
        },
      ],
    });

    expect(response).toBeDefined();

    client.chat.completions.create = originalCreate;
  });

  it("should preserve regular URLs unchanged", async () => {
    const regularUrl =
      "https://upload.wikimedia.org/wikipedia/commons/thumb/d/dd/Gfp-wisconsin-madison-the-nature-boardwalk.jpg/2560px-Gfp-wisconsin-madison-the-nature-boardwalk.jpg";

    const client = wrapOpenAI(new OpenAI({ apiKey: "test-key" }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockCreate = async (params: any) => {
      const content = params.messages[0].content;
      expect(content[1].type).toBe("image_url");

      const imageUrlValue = content[1].image_url.url;
      expect(typeof imageUrlValue).toBe("string");
      expect(imageUrlValue).toBe(regularUrl);

      return {
        choices: [{ message: { content: "Nature boardwalk image." } }],
        usage: { total_tokens: 100, prompt_tokens: 50, completion_tokens: 50 },
      };
    };

    const originalCreate = client.chat.completions.create;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions
    client.chat.completions.create = mockCreate as any;

    const response = await client.chat.completions.create({
      model: TEST_MODEL,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What's in this image?" },
            { type: "image_url", image_url: { url: regularUrl } },
          ],
        },
      ],
    });

    expect(response).toBeDefined();

    client.chat.completions.create = originalCreate;
  });
});
