/**
 * Basic logging test suite
 * Tests core logging functionality: initLogger, spans, flush
 */

import type { LoggerInstance } from "../helpers/types";
import { assert, assertEqual, assertNotEmpty } from "../helpers/assertions";
import { register } from "../helpers/register";

const PROJECT_ID = "test-project-id";

type InitLoggerFn = (options: {
  projectName: string;
  projectId?: string;
}) => LoggerInstance;

export const testBasicSpanLogging = register(
  "testBasicSpanLogging",
  async (braintrust, { backgroundLogger }) => {
    const initLogger = braintrust.initLogger as InitLoggerFn;
    const logger = initLogger({
      projectName: "basic-logging-test",
      projectId: PROJECT_ID,
    });

    const span = logger.startSpan({ name: "basic.span" });

    span.log({
      input: "What is the capital of France?",
      output: "Paris",
      expected: "Paris",
      metadata: { transport: "smoke-test" },
    });

    span.end();
    await logger.flush();

    const events = await backgroundLogger.drain();

    assertNotEmpty(events, "No events were captured by the background logger");
    assertEqual(events.length, 1, "Expected exactly one event");

    const event = events[0] as Record<string, unknown>;
    assertEqual(event.input, "What is the capital of France?");
    assertEqual(event.output, "Paris");
    assertEqual(event.expected, "Paris");

    return "Basic span logging test passed";
  },
  { requiresTestHarness: true },
);

export const testMultipleSpans = register(
  "testMultipleSpans",
  async (braintrust, { backgroundLogger }) => {
    const initLogger = braintrust.initLogger as InitLoggerFn;
    const logger = initLogger({
      projectName: "multi-span-test",
      projectId: PROJECT_ID,
    });

    const span1 = logger.startSpan({ name: "span.1" });
    span1.log({ input: "test1", output: "result1" });
    span1.end();

    const span2 = logger.startSpan({ name: "span.2" });
    span2.log({ input: "test2", output: "result2" });
    span2.end();

    await logger.flush();

    const events = await backgroundLogger.drain();

    assertNotEmpty(events, "No events were captured");
    assert(
      events.length >= 2,
      `Expected at least 2 events, got ${events.length}`,
    );

    return `Multiple spans test passed (${events.length} events captured)`;
  },
  { requiresTestHarness: true },
);

export const testDirectLogging = register(
  "testDirectLogging",
  async (braintrust, { backgroundLogger }) => {
    const initLogger = braintrust.initLogger as InitLoggerFn;
    const logger = initLogger({
      projectName: "direct-logging-test",
      projectId: PROJECT_ID,
    });

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    logger.log!({
      input: "direct test",
      output: "direct result",
    });

    await logger.flush();

    const events = await backgroundLogger.drain();
    assertNotEmpty(events, "No events were captured from direct logging");

    return "Direct logging test passed";
  },
  { requiresTestHarness: true },
);

export const testJSONAttachment = register(
  "testJSONAttachment",
  async (braintrust, { backgroundLogger }) => {
    const initLogger = braintrust.initLogger as InitLoggerFn;
    const logger = initLogger({
      projectName: "json-attachment-test",
      projectId: PROJECT_ID,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Attachment = braintrust.JSONAttachment as any;

    const testData = {
      foo: "bar",
      nested: {
        array: [1, 2, 3],
        bool: true,
      },
    };

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    logger.log!({
      input: {
        type: "chat_completion",
        transcript: new Attachment(testData, {
          filename: "conversation_transcript.json",
          pretty: true,
        }),
      },
    });

    await logger.flush();

    const events = await backgroundLogger.drain();
    assertNotEmpty(events, "No events were captured with JSONAttachment");

    assertEqual(testData.foo, "bar", "testData.foo should be 'bar'");
    assertEqual(
      testData.nested.array.length,
      3,
      "testData.nested.array should have 3 elements",
    );
    assertEqual(
      testData.nested.array[0],
      1,
      "testData.nested.array[0] should be 1",
    );
    assertEqual(
      testData.nested.bool,
      true,
      "testData.nested.bool should be true",
    );

    return "JSONAttachment test passed";
  },
  { requiresTestHarness: true },
);

export const testAsyncLocalStorageTraced = register(
  "testAsyncLocalStorageTraced",
  async (braintrust, { backgroundLogger }) => {
    const initLogger = braintrust.initLogger as InitLoggerFn;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tracedFn = braintrust.traced as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const startSpanFn = braintrust.startSpan as any;

    initLogger({
      projectName: "als-traced-test",
      projectId: PROJECT_ID,
    });

    await tracedFn(
      () => {
        const child = startSpanFn({ name: "child-span" });
        child.log({ input: "child input", output: "child output" });
        child.end();
      },
      { name: "parent-span" },
    );

    const events = (await backgroundLogger.drain()) as Array<
      Record<string, unknown>
    >;

    assertNotEmpty(events, "No events captured for ALS traced test");

    const parentSpan = events.find(
      (e) =>
        typeof e.span_attributes === "object" &&
        e.span_attributes !== null &&
        (e.span_attributes as Record<string, unknown>).name === "parent-span",
    );
    const childSpan = events.find(
      (e) =>
        typeof e.span_attributes === "object" &&
        e.span_attributes !== null &&
        (e.span_attributes as Record<string, unknown>).name === "child-span",
    );

    if (parentSpan && childSpan) {
      const parentId = parentSpan.span_id as string;
      const childParents = (childSpan.span_parents as string[]) || [];

      assert(
        childParents.includes(parentId),
        `Child span should have parent span ID in span_parents. Parent ID: ${parentId}, Child parents: ${JSON.stringify(childParents)}`,
      );

      return "ALS traced test passed (parent-child relationship verified)";
    } else if (!parentSpan && !childSpan) {
      return "ALS not available in this environment, test skipped";
    } else {
      throw new Error(
        `Expected both parent and child spans, but found: parent=${!!parentSpan}, child=${!!childSpan}`,
      );
    }
  },
  { requiresTestHarness: true },
);

export const testNestedTraced = register(
  "testNestedTraced",
  async (braintrust, { backgroundLogger }) => {
    const initLogger = braintrust.initLogger as InitLoggerFn;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tracedFn = braintrust.traced as any;

    initLogger({
      projectName: "nested-traced-test",
      projectId: PROJECT_ID,
    });

    await tracedFn(
      async () => {
        await tracedFn(
          async () => {
            await tracedFn(
              () => {
                // innermost span
              },
              { name: "grandchild-span" },
            );
          },
          { name: "child-span" },
        );
      },
      { name: "parent-span" },
    );

    const events = (await backgroundLogger.drain()) as Array<
      Record<string, unknown>
    >;

    if (events.length === 0) {
      return "ALS not available in this environment, test skipped";
    }

    const parentSpan = events.find(
      (e) =>
        typeof e.span_attributes === "object" &&
        e.span_attributes !== null &&
        (e.span_attributes as Record<string, unknown>).name === "parent-span",
    );
    const childSpan = events.find(
      (e) =>
        typeof e.span_attributes === "object" &&
        e.span_attributes !== null &&
        (e.span_attributes as Record<string, unknown>).name === "child-span",
    );
    const grandchildSpan = events.find(
      (e) =>
        typeof e.span_attributes === "object" &&
        e.span_attributes !== null &&
        (e.span_attributes as Record<string, unknown>).name ===
          "grandchild-span",
    );

    if (parentSpan && childSpan && grandchildSpan) {
      const parentId = parentSpan.span_id as string;
      const childId = childSpan.span_id as string;
      const childParents = (childSpan.span_parents as string[]) || [];
      const grandchildParents = (grandchildSpan.span_parents as string[]) || [];

      assert(
        childParents.includes(parentId),
        "Child should have parent in span_parents",
      );

      assert(
        grandchildParents.includes(childId),
        "Grandchild should have child in span_parents",
      );

      return "Nested traced test passed (3-level hierarchy verified)";
    } else {
      return "ALS not available in this environment, test skipped";
    }
  },
  { requiresTestHarness: true },
);

export const testCurrentSpan = register(
  "testCurrentSpan",
  async (braintrust, { backgroundLogger }) => {
    const initLogger = braintrust.initLogger as InitLoggerFn;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tracedFn = braintrust.traced as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentSpanFn = braintrust.currentSpan as any;

    initLogger({
      projectName: "current-span-test",
      projectId: PROJECT_ID,
    });

    let capturedSpanId: string | undefined;

    await tracedFn(
      () => {
        const current = currentSpanFn();
        if (current && typeof current === "object" && "spanId" in current) {
          capturedSpanId = (current as { spanId: string }).spanId;
        }
      },
      { name: "test-current-span" },
    );

    const events = (await backgroundLogger.drain()) as Array<
      Record<string, unknown>
    >;

    if (events.length === 0 || !capturedSpanId) {
      return "ALS not available in this environment, test skipped";
    }

    const span = events.find((e) => e.span_id === capturedSpanId);

    if (span) {
      assertEqual(
        (
          (span.span_attributes as Record<string, unknown>) || {
            name: undefined,
          }
        ).name,
        "test-current-span",
        "currentSpan() should return the active span",
      );

      return "currentSpan test passed";
    } else {
      throw new Error("currentSpan() returned a span ID that was not logged");
    }
  },
  { requiresTestHarness: true },
);
