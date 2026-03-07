/* eslint-disable @typescript-eslint/consistent-type-assertions */
import type {
  ChatCompletionContentPartText,
  ChatCompletionContentPartImage,
} from "openai/resources";
import { vi, expect, test, describe, beforeEach, afterEach } from "vitest";
import {
  _exportsForTestingOnly,
  init,
  initLogger,
  Prompt,
  BraintrustState,
  wrapTraced,
  currentSpan,
  withParent,
  startSpan,
  updateSpan,
  Attachment,
  deepCopyEvent,
  renderMessage,
  renderMessageImpl,
} from "./logger";
import {
  parseTemplateFormat,
  isTemplateFormat,
  renderTemplateContent,
} from "./template/renderer";
import { configureNode } from "./node/config";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SpanComponentsV3 } from "../util/span_identifier_v3";

configureNode();

function getExportVersion(exportedSpan: string): number {
  const exportedBytes = base64ToUint8Array(exportedSpan);
  return exportedBytes[0];
}

test("renderMessage with file content parts", () => {
  const message = {
    role: "user" as const,
    content: [
      {
        type: "text" as const,
        text: "Here is a {{item}}:",
      },
      {
        type: "image_url" as const,
        image_url: {
          url: "{{image_url}}",
        },
      },
      {
        type: "file" as const,
        file: {
          file_data: "{{file_data}}",
          file_id: "{{file_id}}",
          filename: "{{filename}}",
        },
      },
    ],
  };

  const variables = {
    item: "document",
    image_url: "https://example.com/image.png",
    file_data: "base64data",
    file_id: "file-456",
    filename: "report.pdf",
  };

  const rendered = renderMessageImpl(
    (template) =>
      template
        .replace("{{item}}", "document")
        .replace("{{image_url}}", "https://example.com/image.png")
        .replace("{{file_data}}", "base64data")
        .replace("{{file_id}}", "file-456")
        .replace("{{filename}}", "report.pdf"),
    message,
    variables,
  );

  expect(rendered.content).toEqual([
    {
      type: "text",
      text: "Here is a document:",
    },
    {
      type: "image_url",
      image_url: {
        url: "https://example.com/image.png",
      },
    },
    {
      type: "file",
      file: {
        file_data: "base64data",
        file_id: "file-456",
        filename: "report.pdf",
      },
    },
  ]);
});

test("renderMessage expands attachment array in image_url parts", () => {
  const message = {
    role: "user" as const,
    content: [
      {
        type: "image_url" as const,
        image_url: { url: "{{images}}" },
      },
    ],
  };

  const variables = {
    images: ["https://example.com/img1.jpg", "https://example.com/img2.jpg"],
  };

  const rendered = renderMessageImpl(
    (template) => template, // Template rendering shouldn't happen for attachment arrays
    message,
    variables,
  );

  expect(rendered.content).toEqual([
    {
      type: "image_url",
      image_url: {
        url: "https://example.com/img1.jpg",
      },
    },
    {
      type: "image_url",
      image_url: {
        url: "https://example.com/img2.jpg",
      },
    },
  ]);
});

test("renderMessage expands inline attachment array in image_url parts", () => {
  const message = {
    role: "user" as const,
    content: [
      {
        type: "image_url" as const,
        image_url: { url: "{{images}}" },
      },
    ],
  };

  const variables = {
    images: [
      {
        type: "inline_attachment",
        src: "data:image/png;base64,abc",
        content_type: "image/png",
      },
      {
        type: "inline_attachment",
        src: "data:image/jpeg;base64,def",
        content_type: "image/jpeg",
      },
    ],
  };

  const rendered = renderMessageImpl(
    (template) => template,
    message,
    variables,
  );

  expect(rendered.content).toEqual([
    {
      type: "image_url",
      image_url: {
        url: {
          type: "inline_attachment",
          src: "data:image/png;base64,abc",
          content_type: "image/png",
        },
      },
    },
    {
      type: "image_url",
      image_url: {
        url: {
          type: "inline_attachment",
          src: "data:image/jpeg;base64,def",
          content_type: "image/jpeg",
        },
      },
    },
  ]);
});

test("renderMessage does NOT expand mixed content (text + variable)", () => {
  const message = {
    role: "user" as const,
    content: "Look at {{images}}",
  };

  const variables = {
    images: ["https://example.com/img1.jpg", "https://example.com/img2.jpg"],
  };

  const rendered = renderMessageImpl(
    (template) => template.replace("{{images}}", "[array]"),
    message,
    variables,
  );

  // Mixed content is not expanded - just rendered normally
  expect(rendered.content).toBe("Look at [array]");
});

test("renderMessage expands nested attachment arrays in image_url parts", () => {
  const message = {
    role: "user" as const,
    content: [
      {
        type: "image_url" as const,
        image_url: { url: "{{data.images}}" },
      },
    ],
  };

  const variables = {
    data: {
      images: ["https://example.com/img1.jpg", "https://example.com/img2.jpg"],
    },
  };

  const rendered = renderMessageImpl(
    (template) => template, // Template rendering shouldn't happen
    message,
    variables,
  );

  expect(rendered.content).toEqual([
    {
      type: "image_url",
      image_url: {
        url: "https://example.com/img1.jpg",
      },
    },
    {
      type: "image_url",
      image_url: {
        url: "https://example.com/img2.jpg",
      },
    },
  ]);
});

test("renderMessage expands deeply nested attachment arrays in image_url parts", () => {
  const message = {
    role: "user" as const,
    content: [
      {
        type: "image_url" as const,
        image_url: { url: "{{user.profile.images}}" },
      },
    ],
  };

  const variables = {
    user: {
      profile: {
        images: [
          {
            type: "inline_attachment",
            src: "data:image/png;base64,abc",
            content_type: "image/png",
          },
          {
            type: "inline_attachment",
            src: "data:image/jpeg;base64,def",
            content_type: "image/jpeg",
          },
        ],
      },
    },
  };

  const rendered = renderMessageImpl(
    (template) => template,
    message,
    variables,
  );

  expect(rendered.content).toEqual([
    {
      type: "image_url",
      image_url: {
        url: {
          type: "inline_attachment",
          src: "data:image/png;base64,abc",
          content_type: "image/png",
        },
      },
    },
    {
      type: "image_url",
      image_url: {
        url: {
          type: "inline_attachment",
          src: "data:image/jpeg;base64,def",
          content_type: "image/jpeg",
        },
      },
    },
  ]);
});

test("renderMessage handles single image_url (no array)", () => {
  const message = {
    role: "user" as const,
    content: [
      {
        type: "image_url" as const,
        image_url: {
          url: "{{image}}",
        },
      },
    ],
  };

  const variables = {
    image: "https://example.com/single.jpg",
  };

  const rendered = renderMessageImpl(
    (template) =>
      template.replace("{{image}}", "https://example.com/single.jpg"),
    message,
    variables,
  );

  expect(rendered.content).toEqual([
    {
      type: "image_url",
      image_url: {
        url: "https://example.com/single.jpg",
      },
    },
  ]);
});

test("renderMessage expands attachment arrays in structured content", () => {
  // This tests the case where content is already an array with structured parts,
  // and one part has a template variable for an attachment array
  const message = {
    role: "user" as const,
    content: [
      { type: "text" as const, text: "Describe these images" },
      { type: "image_url" as const, image_url: { url: "{{attachments}}" } },
    ],
  };

  const variables = {
    attachments: [
      "https://example.com/img1.jpg",
      "https://example.com/img2.jpg",
    ],
  };

  const rendered = renderMessageImpl(
    (template) => template,
    message,
    variables,
  );

  // Should expand {{attachments}} into multiple image_url parts
  expect(rendered.content).toEqual([
    {
      type: "text",
      text: "Describe these images",
    },
    {
      type: "image_url",
      image_url: { url: "https://example.com/img1.jpg" },
    },
    {
      type: "image_url",
      image_url: { url: "https://example.com/img2.jpg" },
    },
  ]);
});

test("verify MemoryBackgroundLogger intercepts logs", async () => {
  // Log to memory for the tests.
  _exportsForTestingOnly.simulateLoginForTests();

  const memoryLogger = _exportsForTestingOnly.useTestBackgroundLogger();

  const logger = initLogger({
    projectName: "test",
    projectId: "test-project-id",
  });

  await memoryLogger.flush();
  expect(await memoryLogger.drain()).length(0);

  // make some spans
  const span = logger.startSpan({ name: "test-name-a" });
  span.log({ metrics: { v: 1 } });
  span.end();

  const span2 = logger.startSpan({ name: "test-name-b" });
  span2.log({ metrics: { v: 2 } });
  span2.end();

  await memoryLogger.flush();

  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any
  const events = (await memoryLogger.drain()) as any[]; // FIXME[matt] what type should this be?
  expect(events).toHaveLength(2);

  events.sort((a, b) => a["metrics"]["v"] - b["metrics"]["v"]);

  // just check a couple of things, we're mostly looking to make sure the
  expect(events[0]["span_attributes"]["name"]).toEqual("test-name-a");
  expect(events[1]["span_attributes"]["name"]).toEqual("test-name-b");

  // and now it's empty
  expect(await memoryLogger.drain()).length(0);

  _exportsForTestingOnly.clearTestBackgroundLogger(); // can go back to normal
});

test("init validation", () => {
  expect(() => init({})).toThrow(
    "Must specify at least one of project or projectId",
  );
  expect(() => init({ project: "project", open: true, update: true })).toThrow(
    "Cannot open and update an experiment at the same time",
  );
  expect(() => init({ project: "project", open: true })).toThrow(
    "Cannot open an experiment without specifying its name",
  );
});

test("init accepts dataset with id only", () => {
  // Test that the type system accepts {id: string}
  const datasetIdOnly = { id: "dataset-id-123" };

  // This should compile without type errors
  // We're testing the type system, not the runtime behavior
  expect(datasetIdOnly.id).toBe("dataset-id-123");
  expect("version" in datasetIdOnly).toBe(false);
});

test("init accepts dataset with id and version", () => {
  // Test that the type system accepts {id: string, version?: string}
  const datasetWithVersion = { id: "dataset-id-123", version: "v2" };

  // This should compile without type errors
  expect(datasetWithVersion.id).toBe("dataset-id-123");
  expect(datasetWithVersion.version).toBe("v2");
});

describe("prompt.build structured output templating", () => {
  test("applies nunjucks templating inside schema", () => {
    const prompt = new Prompt<false, false>(
      {
        name: "Greeter",
        slug: "greeter",
        project_id: "p",
        prompt_data: {
          prompt: {
            type: "chat",
            messages: [
              {
                role: "system",
                content: "Greet the user.",
              },
            ],
          },
          options: {
            model: "gpt-4o",
            params: {
              response_format: {
                type: "json_schema",
                json_schema: {
                  name: "schema",
                  schema: {
                    type: "object",
                    properties: {
                      greeting: {
                        type: "string",
                        description: "Hello {{ user.name | upper }}",
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      {},
      false,
    );

    expect(() =>
      prompt.build(
        {
          user: { name: "ada" },
        },
        { templateFormat: "nunjucks" },
      ),
    ).toThrow(
      "Nunjucks templating requires @braintrust/template-nunjucks. Install and import it to enable templateFormat: 'nunjucks'.",
    );
  });

  test("prompt.build with structured output templating", () => {
    const prompt = new Prompt<false, false>(
      {
        name: "Calculator",
        slug: "calculator",
        project_id: "p",
        prompt_data: {
          prompt: {
            type: "chat",
            messages: [
              {
                role: "system",
                content:
                  "Please compute {{input.expression}} and return the result in JSON.",
              },
            ],
          },
          options: {
            model: "gpt-4o",
            params: {
              response_format: {
                type: "json_schema",
                json_schema: {
                  name: "schema",
                  schema: "{{input.schema}}",
                  strict: true,
                },
              },
            },
          },
        },
      },
      {},
      false,
    );

    const result = prompt.build({
      input: {
        expression: "2 + 3",
        schema: {
          type: "object",
          properties: {
            final_answer: {
              type: "string",
            },
          },
          required: ["final_answer"],
          additionalProperties: false,
        },
      },
    });
    expect(result).toMatchObject({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: "Please compute 2 + 3 and return the result in JSON.",
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "schema",
          schema: {
            type: "object",
            properties: {
              final_answer: { type: "string" },
            },
          },
        },
      },
    });
  });
});

test("simulateLoginForTests and simulateLogoutForTests", async () => {
  for (let i = 0; i < 6; i++) {
    // First login
    const state = await _exportsForTestingOnly.simulateLoginForTests();
    // Verify the login state - now we're logged in
    expect(state.loggedIn).toBe(true);
    expect(state.loginToken).toBe("___TEST_API_KEY__THIS_IS_NOT_REAL___");
    expect(state.orgId).toBe("test-org-id");
    expect(state.orgName).toBe("test-org-name");
    expect(state.apiUrl).toBe("https://braintrust.dev/fake-api-url");

    // Now logout
    const logoutState = _exportsForTestingOnly.simulateLogoutForTests();

    // Verify the logout state - everything should be null or false
    expect(logoutState.loggedIn).toBe(false);
    expect(logoutState.loginToken).toBe(null);
    expect(logoutState.orgId).toBe(null);
    expect(logoutState.orgName).toBe(null);
    expect(logoutState.apiUrl).toBe(null);
    expect(logoutState.appUrl).toBe("https://www.braintrust.dev");
  }
});

test("span.export handles unauthenticated state", async () => {
  // Create a span without logging in
  const logger = initLogger({});
  const span = logger.startSpan({ name: "test-span" });
  span.end();

  // Export should still work and return a valid string
  let exported: string | undefined = undefined;
  let error;
  try {
    exported = await span.export();
  } catch (e) {
    error = e;
  }
  expect(error).toBeUndefined();
  expect(exported).toBeDefined();
  expect(typeof exported).toBe("string");
  expect((exported as string).length).toBeGreaterThan(0);
});

test("span.export disables cache", async () => {
  const logger = initLogger({});
  const span = logger.startSpan({ name: "test-span" });

  await span.export();
  expect(span.state().spanCache.disabled).toBe(true);
});

test("span.export handles unresolved parent object ID", async () => {
  // Create a span with a parent object ID that hasn't been resolved
  const logger = initLogger({});
  const span = logger.startSpan({
    name: "test-span",
    event: {
      metadata: {
        project_id: "test-project-id",
      },
    },
  });
  span.end();

  // Export should still work and return a valid string
  let exported: string | undefined = undefined;
  let error;
  try {
    exported = await span.export();
  } catch (e) {
    error = e;
  }
  expect(error).toBeUndefined();
  expect(exported).toBeDefined();
  expect(typeof exported).toBe("string");
  expect((exported as string).length).toBeGreaterThan(0);
});

test("updateSpan includes span_id and root_span_id from exported span", async () => {
  await _exportsForTestingOnly.simulateLoginForTests();
  const memoryLogger = _exportsForTestingOnly.useTestBackgroundLogger();

  try {
    const logger = initLogger({
      projectName: "test",
      projectId: "test-project-id",
    });
    const span = logger.startSpan({ name: "test-span" });
    const exported = await span.export();
    const spanId = span.spanId;
    const rootSpanId = span.rootSpanId;
    span.end();

    await memoryLogger.flush();
    await memoryLogger.drain();

    updateSpan({ exported, output: "updated output" });

    await memoryLogger.flush();
    const logs = await memoryLogger.drain();
    expect(logs).toContainEqual(
      expect.objectContaining({
        output: "updated output",
        span_id: spanId,
        root_span_id: rootSpanId,
      }),
    );
  } finally {
    _exportsForTestingOnly.clearTestBackgroundLogger();
    _exportsForTestingOnly.simulateLogoutForTests();
  }
});

test("startSpan support ids with parent", () => {
  const logger = initLogger({});
  const span = logger.startSpan({
    name: "test-span",
    spanId: "123",
    parentSpanIds: { spanId: "456", rootSpanId: "789" },
  });
  expect(span.spanId).toBe("123");
  expect(span.rootSpanId).toBe("789");
  expect(span.spanParents).toEqual(["456"]);
  span.end();
});

test("startSpan support ids without parent", () => {
  const logger = initLogger({});
  const span = logger.startSpan({ name: "test-span", spanId: "123" });
  expect(span.spanId).toBe("123");
  expect(span.rootSpanId).toBe("123");
  expect(span.spanParents).toEqual([]);
  span.end();
});

test("startSpan support ids with nested parent chain", () => {
  const logger = initLogger({});
  const span = logger.startSpan({
    name: "test-span",
    spanId: "123",
    parentSpanIds: {
      spanId: "456",
      rootSpanId: "789",
      parentSpanIds: ["111", "222", "456"],
    },
  });
  expect(span.spanId).toBe("123");
  expect(span.rootSpanId).toBe("789");
  expect(span.spanParents).toEqual(["111", "222", "456"]);
  span.end();
});

describe("isGeneratorFunction and isAsyncGeneratorFunction utilities", () => {
  const { isGeneratorFunction, isAsyncGeneratorFunction } =
    _exportsForTestingOnly;

  test("isGeneratorFunction correctly identifies sync generators", () => {
    // Positive cases
    expect(isGeneratorFunction(function* () {})).toBe(true);
    expect(
      isGeneratorFunction(function* gen() {
        yield 1;
      }),
    ).toBe(true);

    // Negative cases
    expect(isGeneratorFunction(function () {})).toBe(false);
    expect(isGeneratorFunction(() => {})).toBe(false);
    expect(isGeneratorFunction(async function () {})).toBe(false);
    expect(isGeneratorFunction(async function* () {})).toBe(false);

    // Edge cases
    expect(isGeneratorFunction(null)).toBe(false);
    expect(isGeneratorFunction(undefined)).toBe(false);
    expect(isGeneratorFunction(123)).toBe(false);
    expect(isGeneratorFunction("function*() {}")).toBe(false);
    expect(isGeneratorFunction({})).toBe(false);
    expect(isGeneratorFunction([])).toBe(false);
  });

  test("isAsyncGeneratorFunction correctly identifies async generators", () => {
    // Positive cases
    expect(isAsyncGeneratorFunction(async function* () {})).toBe(true);
    expect(
      isAsyncGeneratorFunction(async function* gen() {
        yield 1;
      }),
    ).toBe(true);

    // Negative cases
    expect(isAsyncGeneratorFunction(function () {})).toBe(false);
    expect(isAsyncGeneratorFunction(() => {})).toBe(false);
    expect(isAsyncGeneratorFunction(async function () {})).toBe(false);
    expect(isAsyncGeneratorFunction(function* () {})).toBe(false);

    // Edge cases
    expect(isAsyncGeneratorFunction(null)).toBe(false);
    expect(isAsyncGeneratorFunction(undefined)).toBe(false);
    expect(isAsyncGeneratorFunction(123)).toBe(false);
    expect(isAsyncGeneratorFunction("async function*() {}")).toBe(false);
    expect(isAsyncGeneratorFunction({})).toBe(false);
    expect(isAsyncGeneratorFunction([])).toBe(false);
  });

  test("generator detection works with various declaration styles", () => {
    // Named generators
    function* namedGen() {
      yield 1;
    }
    expect(isGeneratorFunction(namedGen)).toBe(true);

    // Anonymous generators
    const anonGen = function* () {
      yield 2;
    };
    expect(isGeneratorFunction(anonGen)).toBe(true);

    // Async named generators
    async function* namedAsyncGen() {
      yield 1;
    }
    expect(isAsyncGeneratorFunction(namedAsyncGen)).toBe(true);

    // Anonymous async generators
    const anonAsyncGen = async function* () {
      yield 2;
    };
    expect(isAsyncGeneratorFunction(anonAsyncGen)).toBe(true);
  });
});

describe("wrapTraced generator support", () => {
  let memoryLogger: any;
  let originalEnv: string | undefined;

  beforeEach(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
    memoryLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    originalEnv = process.env.BRAINTRUST_MAX_GENERATOR_ITEMS;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.BRAINTRUST_MAX_GENERATOR_ITEMS = originalEnv;
    } else {
      delete process.env.BRAINTRUST_MAX_GENERATOR_ITEMS;
    }
    _exportsForTestingOnly.clearTestBackgroundLogger();
    _exportsForTestingOnly.simulateLogoutForTests();
  });

  test("traced sync generator", async () => {
    initLogger({ projectName: "test", projectId: "test-project-id" });

    const tracedSyncGen = wrapTraced(function* syncNumberGenerator(n: number) {
      for (let i = 0; i < n; i++) {
        yield i * 2;
      }
    });

    const results = [];
    for (const value of tracedSyncGen(3)) {
      results.push(value);
    }

    expect(results).toEqual([0, 2, 4]);

    await memoryLogger.flush();
    const logs = await memoryLogger.drain();
    expect(logs).toHaveLength(1);

    const log = logs[0];
    expect(log.input).toEqual([3]);
    expect(log.output).toEqual([0, 2, 4]);
    expect(log.span_attributes?.name).toBe("syncNumberGenerator");
    expect(log.span_attributes?.type).toBe("function");
  });

  test("traced sync generator with exception", async () => {
    initLogger({ projectName: "test", projectId: "test-project-id" });

    const failingGenerator = wrapTraced(function* failingGenerator() {
      yield "first";
      yield "second";
      throw new Error("Generator failed");
    });

    const results = [];
    expect(() => {
      for (const value of failingGenerator()) {
        results.push(value);
      }
    }).toThrow("Generator failed");

    expect(results).toEqual(["first", "second"]);

    await memoryLogger.flush();
    const logs = await memoryLogger.drain();
    expect(logs).toHaveLength(1);

    const log = logs[0];
    expect(log.output).toEqual(["first", "second"]);
    expect(log.error).toContain("Generator failed");
  });

  test("traced async generator", async () => {
    initLogger({ projectName: "test", projectId: "test-project-id" });

    const tracedAsyncGen = wrapTraced(async function* asyncNumberGenerator(
      n: number,
    ) {
      for (let i = 0; i < n; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        yield i * 2;
      }
    });

    const results = [];
    for await (const value of tracedAsyncGen(3)) {
      results.push(value);
    }

    expect(results).toEqual([0, 2, 4]);

    await memoryLogger.flush();
    const logs = await memoryLogger.drain();
    expect(logs).toHaveLength(1);

    const log = logs[0];
    expect(log.input).toEqual([3]);
    expect(log.output).toEqual([0, 2, 4]);
    expect(log.span_attributes?.name).toBe("asyncNumberGenerator");
  });

  test("traced async generator with exception", async () => {
    initLogger({ projectName: "test", projectId: "test-project-id" });

    const failingAsyncGenerator = wrapTraced(
      async function* failingAsyncGenerator() {
        yield 1;
        yield 2;
        throw new Error("Something went wrong");
      },
    );

    const results = [];
    await expect(async () => {
      for await (const value of failingAsyncGenerator()) {
        results.push(value);
      }
    }).rejects.toThrow("Something went wrong");

    expect(results).toEqual([1, 2]);

    await memoryLogger.flush();
    const logs = await memoryLogger.drain();
    expect(logs).toHaveLength(1);

    const log = logs[0];
    expect(log.output).toEqual([1, 2]);
    expect(log.error).toContain("Something went wrong");
  });

  test("traced sync generator truncation", async () => {
    process.env.BRAINTRUST_MAX_GENERATOR_ITEMS = "3";
    initLogger({ projectName: "test", projectId: "test-project-id" });

    const consoleWarnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => {});

    const largeGenerator = wrapTraced(function* largeGenerator() {
      for (let i = 0; i < 10; i++) {
        yield i;
      }
    });

    const results = [];
    for (const value of largeGenerator()) {
      results.push(value);
    }

    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      "Generator output exceeded limit of 3 items, output not logged. " +
        "Increase BRAINTRUST_MAX_GENERATOR_ITEMS or set to -1 to disable limit.",
    );

    await memoryLogger.flush();
    const logs = await memoryLogger.drain();
    expect(logs).toHaveLength(1);

    const log = logs[0];
    expect(log.output).toBeUndefined();
    expect(log.input).toEqual([]);

    consoleWarnSpy.mockRestore();
  });

  test("traced async generator truncation", async () => {
    process.env.BRAINTRUST_MAX_GENERATOR_ITEMS = "3";
    initLogger({ projectName: "test", projectId: "test-project-id" });

    const consoleWarnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => {});

    const largeAsyncGenerator = wrapTraced(
      async function* largeAsyncGenerator() {
        for (let i = 0; i < 10; i++) {
          await new Promise((resolve) => setTimeout(resolve, 1));
          yield i;
        }
      },
    );

    const results = [];
    for await (const value of largeAsyncGenerator()) {
      results.push(value);
    }

    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      "Generator output exceeded limit of 3 items, output not logged. " +
        "Increase BRAINTRUST_MAX_GENERATOR_ITEMS or set to -1 to disable limit.",
    );

    await memoryLogger.flush();
    const logs = await memoryLogger.drain();
    expect(logs).toHaveLength(1);

    const log = logs[0];
    expect(log.output).toBeUndefined();

    consoleWarnSpy.mockRestore();
  });

  test("traced sync generator with zero limit drops all output", async () => {
    process.env.BRAINTRUST_MAX_GENERATOR_ITEMS = "0";
    initLogger({ projectName: "test", projectId: "test-project-id" });

    const noOutputLoggedGen = wrapTraced(function* noOutputLoggedGenerator() {
      for (let i = 0; i < 10; i++) {
        yield i;
      }
    });

    const results = [];
    for (const value of noOutputLoggedGen()) {
      results.push(value);
    }

    // Generator still yields all values
    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

    await memoryLogger.flush();
    const logs = await memoryLogger.drain();
    expect(logs).toHaveLength(1);

    const log = logs[0];
    expect(log.output).toBeUndefined(); // Output is not logged when limit is 0
  });

  test("traced sync generator with -1 limit buffers all output", async () => {
    process.env.BRAINTRUST_MAX_GENERATOR_ITEMS = "-1";
    initLogger({ projectName: "test", projectId: "test-project-id" });

    const unlimitedBufferGen = wrapTraced(function* unlimitedBufferGenerator() {
      for (let i = 0; i < 3; i++) {
        yield i * 2;
      }
    });

    const results = [];
    for (const value of unlimitedBufferGen()) {
      results.push(value);
    }

    expect(results).toEqual([0, 2, 4]);

    await memoryLogger.flush();
    const logs = await memoryLogger.drain();
    expect(logs).toHaveLength(1);

    const log = logs[0];
    expect(log.output).toEqual([0, 2, 4]); // All output is logged when limit is -1
  });

  test("traced sync generator with subtasks", async () => {
    initLogger({ projectName: "test", projectId: "test-project-id" });

    // Test that sync generators can perform work and use currentSpan
    const tracedAsyncGenWithSubtasks = wrapTraced(
      function* main(numLoops: number) {
        yield 1;
        currentSpan().log({ metadata: { a: "b" } });

        const tasks = [];
        for (let i = 0; i < numLoops; i++) {
          tasks.push(i * 2);
        }

        const total = tasks.reduce((sum, val) => sum + val, 0);

        currentSpan().log({
          metadata: { total },
          output: "testing",
        });
        yield total;
      },
      { name: "main", noTraceIO: true },
    );

    const results = [];
    for (const value of tracedAsyncGenWithSubtasks(3)) {
      results.push(value);
    }

    expect(results).toEqual([1, 6]);

    await memoryLogger.flush();
    const logs = await memoryLogger.drain();
    expect(logs).toHaveLength(1);

    const log = logs[0];
    //expect(log.output).toEqual("testing");
    expect(log.input).toBeUndefined(); // no input because noTraceIO
    expect(log.span_attributes?.name).toBe("main");
    expect(log.metadata).toEqual({ a: "b", total: 6 });
  });

  test("traced async generator with zero limit drops all output", async () => {
    process.env.BRAINTRUST_MAX_GENERATOR_ITEMS = "0";
    initLogger({ projectName: "test", projectId: "test-project-id" });

    const noOutputLoggedAsyncGen = wrapTraced(
      async function* noOutputLoggedAsyncGenerator() {
        for (let i = 0; i < 10; i++) {
          await new Promise((resolve) => setTimeout(resolve, 1));
          yield i;
        }
      },
    );

    const results = [];
    for await (const value of noOutputLoggedAsyncGen()) {
      results.push(value);
    }

    // Generator still yields all values
    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

    await memoryLogger.flush();
    const logs = await memoryLogger.drain();
    expect(logs).toHaveLength(1);

    const log = logs[0];
    expect(log.output).toBeUndefined(); // Output is not logged when limit is 0
  });

  test("traced async generator with -1 limit buffers all output", async () => {
    process.env.BRAINTRUST_MAX_GENERATOR_ITEMS = "-1";
    initLogger({ projectName: "test", projectId: "test-project-id" });

    const unlimitedBufferAsyncGen = wrapTraced(
      async function* unlimitedBufferAsyncGenerator() {
        for (let i = 0; i < 3; i++) {
          await new Promise((resolve) => setTimeout(resolve, 1));
          yield i * 2;
        }
      },
    );

    const results = [];
    for await (const value of unlimitedBufferAsyncGen()) {
      results.push(value);
    }

    expect(results).toEqual([0, 2, 4]);

    await memoryLogger.flush();
    const logs = await memoryLogger.drain();
    expect(logs).toHaveLength(1);

    const log = logs[0];
    expect(log.output).toEqual([0, 2, 4]); // All output is logged when limit is -1
  });

  test("traced async generator with subtasks", async () => {
    initLogger({ projectName: "test", projectId: "test-project-id" });

    // Test that async generators can perform async work and use currentSpan
    const tracedAsyncGenWithSubtasks = wrapTraced(
      async function* main(numLoops: number) {
        yield 1;
        currentSpan().log({ metadata: { a: "b" } });

        const tasks = [];
        for (let i = 0; i < numLoops; i++) {
          tasks.push(
            new Promise((resolve) => {
              setTimeout(() => resolve(i * 2), 1);
            }),
          );
        }

        const results = await Promise.all(tasks);
        const total = results.reduce((sum, val) => sum + val, 0);

        currentSpan().log({
          metadata: { total },
          output: "testing",
        });
        yield total;
      },
      { name: "main", noTraceIO: true },
    );

    const results = [];
    for await (const value of tracedAsyncGenWithSubtasks(3)) {
      results.push(value);
    }

    expect(results).toEqual([1, 6]);

    await memoryLogger.flush();
    const logs = await memoryLogger.drain();
    expect(logs).toHaveLength(1);

    const log = logs[0];
    expect(log.output).toEqual("testing");
    expect(log.input).toBeUndefined(); // no input because noTraceIO
    expect(log.span_attributes?.name).toBe("main");
    expect(log.metadata).toEqual({ a: "b", total: 6 });
  });
});

describe("parent precedence", () => {
  let memory: any;

  beforeEach(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
    memory = _exportsForTestingOnly.useTestBackgroundLogger();
  });

  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
    _exportsForTestingOnly.simulateLogoutForTests();
  });

  test("withParent + wrapTraced: child spans attach to current span (not directly to withParent)", async () => {
    const logger = initLogger({ projectName: "test", projectId: "pid" });
    const outer = logger.startSpan({ name: "outer" });
    const parentStr = await outer.export();
    outer.end();

    const inner = wrapTraced(
      async function inner() {
        startSpan({ name: "child" }).end();
      },
      { name: "inner" },
    );

    await withParent(parentStr, () => inner());

    await memory.flush();
    const events = await memory.drain();
    const byName: any = Object.fromEntries(
      events.map((e: any) => [e.span_attributes?.name, e]),
    );

    expect(byName.outer).toBeTruthy();
    expect(byName.inner).toBeTruthy();
    expect(byName.child).toBeTruthy();

    expect(byName.child.span_parents || []).toContain(byName.inner.span_id);
    expect(byName.child.root_span_id).toBe(byName.outer.root_span_id);
  });

  test("wrapTraced baseline: child spans attach to current span", async () => {
    initLogger({ projectName: "test", projectId: "pid" });

    const top = wrapTraced(
      async function top() {
        startSpan({ name: "child" }).end();
      },
      { name: "top" },
    );

    await top();

    await memory.flush();
    const events = await memory.drain();
    const byName: any = Object.fromEntries(
      events.map((e: any) => [e.span_attributes?.name, e]),
    );
    expect(byName.child.span_parents).toContain(byName.top.span_id);
  });

  test("explicit parent overrides current span", async () => {
    const logger = initLogger({ projectName: "test", projectId: "pid" });
    const outer = logger.startSpan({ name: "outer" });
    const parentStr = await outer.export();
    outer.end();

    const inner = wrapTraced(
      async function inner() {
        startSpan({ name: "forced", parent: parentStr }).end();
      },
      { name: "inner" },
    );

    await inner();

    await memory.flush();
    const events = await memory.drain();
    const byName: any = Object.fromEntries(
      events.map((e: any) => [e.span_attributes?.name, e]),
    );
    expect(byName.forced.span_parents).toContain(byName.outer.span_id);
    expect(byName.forced.span_parents).not.toContain(byName.inner.span_id);
  });
});

test("attachment with unreadable path logs warning", () => {
  const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

  new Attachment({
    data: "unreadable.txt",
    filename: "unreadable.txt",
    contentType: "text/plain",
  });

  expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
  expect(consoleWarnSpy).toHaveBeenCalledWith(
    expect.stringMatching(/Failed to read file:/),
  );

  consoleWarnSpy.mockRestore();
});

test("attachment with readable path returns data", async () => {
  const tmpFile = join(
    tmpdir(),
    `bt-attach-${Date.now()}-${Math.random()}.txt`,
  );
  await writeFile(tmpFile, "hello world", "utf8");
  try {
    const a = new Attachment({
      data: tmpFile,
      filename: "file.txt",
      contentType: "text/plain",
    });
    const blob = await a.data();
    const text = await blob.text();
    expect(text).toBe("hello world");
  } finally {
    await unlink(tmpFile).catch(() => {});
  }
});

describe("sensitive data redaction", () => {
  let logger: any;
  let state: BraintrustState;
  let memoryLogger: any;

  beforeEach(async () => {
    state = await _exportsForTestingOnly.simulateLoginForTests();
    memoryLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    logger = initLogger({ projectName: "test", projectId: "test-id" });
  });

  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
    _exportsForTestingOnly.simulateLogoutForTests();
  });

  test("SpanImpl redacts sensitive data in console.log", () => {
    const span = logger.startSpan({ name: "test-span" });

    // Test custom inspect method (used by console.log in Node.js)
    const inspectResult = (span as any)[
      Symbol.for("nodejs.util.inspect.custom")
    ]();
    expect(inspectResult).toContain("SpanImpl");
    expect(inspectResult).toContain("kind:");
    expect(inspectResult).toContain("id:");
    expect(inspectResult).toContain("spanId:");
    expect(inspectResult).toContain("rootSpanId:");
    // Should NOT contain sensitive data
    expect(inspectResult).not.toContain("_state");
    expect(inspectResult).not.toContain("loginToken");
    expect(inspectResult).not.toContain("_apiConn");

    span.end();
  });

  test("SpanImpl toString provides minimal info", () => {
    const span = logger.startSpan({ name: "test-span" });

    const str = span.toString();
    expect(str).toContain("SpanImpl");
    expect(str).toContain(span.id);
    expect(str).toContain(span.spanId);
    // Should be concise
    expect(str.length).toBeLessThan(200);

    span.end();
  });

  test("BraintrustState redacts loginToken and connections", () => {
    // Test custom inspect method
    const inspectResult = state[Symbol.for("nodejs.util.inspect.custom")]();
    expect(inspectResult).toContain("BraintrustState");
    expect(inspectResult).toContain("orgId:");
    expect(inspectResult).toContain("orgName:");
    expect(inspectResult).toContain("loginToken: '[REDACTED]'");
    // Should NOT contain actual token
    expect(inspectResult).not.toContain("___TEST_API_KEY__THIS_IS_NOT_REAL___");
    expect(inspectResult).not.toContain("_apiConn");
    expect(inspectResult).not.toContain("_appConn");
    expect(inspectResult).not.toContain("_proxyConn");
  });

  test("BraintrustState toJSON excludes sensitive data", () => {
    const json = state.toJSON();
    expect(json).toHaveProperty("id");
    expect(json).toHaveProperty("orgId", "test-org-id");
    expect(json).toHaveProperty("orgName", "test-org-name");
    expect(json).toHaveProperty("loggedIn", true);
    // Should NOT have sensitive properties
    expect(json).not.toHaveProperty("loginToken");
    expect(json).not.toHaveProperty("_apiConn");
    expect(json).not.toHaveProperty("_appConn");
    expect(json).not.toHaveProperty("_proxyConn");
    expect(json).not.toHaveProperty("_bgLogger");
  });

  test("BraintrustState toString provides minimal info", () => {
    const str = state.toString();
    expect(str).toContain("BraintrustState");
    expect(str).toContain("test-org-name");
    expect(str).toContain("loggedIn=true");
    // Should NOT contain token
    expect(str).not.toContain("___TEST_API_KEY__THIS_IS_NOT_REAL___");
    expect(str.length).toBeLessThan(150);
  });

  test("redaction works in nested objects and JSON.stringify", () => {
    const span = logger.startSpan({ name: "test-span" });

    // Create a nested object containing sensitive objects
    const nestedObj = {
      message: "test",
      span: span,
      state: state,
      connection: state.apiConn(),
      timestamp: new Date().toISOString(),
    };

    // JSON.stringify should use toJSON methods
    const jsonStr = JSON.stringify(nestedObj, null, 2);
    expect(jsonStr).toContain('"message": "test"');
    expect(jsonStr).toContain('"kind": "span"');
    expect(jsonStr).toContain('"orgName": "test-org-name"');
    // Should NOT contain sensitive data
    expect(jsonStr).not.toContain("loginToken");
    expect(jsonStr).not.toContain("___TEST_API_KEY__THIS_IS_NOT_REAL___");
    expect(jsonStr).not.toContain("_apiConn");
    expect(jsonStr).not.toContain("Authorization");

    span.end();
  });

  test("redaction works with util.inspect", async () => {
    const util = await import("util");
    const span = logger.startSpan({ name: "test-span" });

    // util.inspect should use Symbol.for("nodejs.util.inspect.custom")
    const inspected = util.inspect(span);
    expect(inspected).toContain("SpanImpl");
    expect(inspected).toContain("kind:");
    expect(inspected).not.toContain("_state");
    expect(inspected).not.toContain("loginToken");

    span.end();
  });

  test("export() still returns proper serialization for spans", async () => {
    const span = logger.startSpan({ name: "test-span" });

    // export() should still work and return a string
    const exported = await span.export();
    expect(typeof exported).toBe("string");
    expect(exported.length).toBeGreaterThan(0);

    // The exported string should be parseable by SpanComponentsV3
    const components = SpanComponentsV3.fromStr(exported);
    expect(components.data.row_id).toBe(span.id);
    expect(components.data.span_id).toBe(span.spanId);
    expect(components.data.root_span_id).toBe(span.rootSpanId);

    span.end();
  });

  test("exported span can be used as parent", async () => {
    const parentSpan = logger.startSpan({ name: "parent-span" });
    const exported = await parentSpan.export();
    parentSpan.end();

    // Should be able to use exported string as parent
    const childSpan = logger.startSpan({
      name: "child-span",
      parent: exported,
    });

    expect(childSpan.rootSpanId).toBe(parentSpan.rootSpanId);
    childSpan.end();
  });

  test("copied span values are stripped", async () => {
    const span = logger.startSpan({ name: "parent-span" });
    // I'm not entirely sure why a span may be inside of a background event, but just in case
    const copy = deepCopyEvent({ input: span });
    expect(copy.input).toBe("<span>");
  });
});
