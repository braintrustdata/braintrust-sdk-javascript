/* These tests have been isolated from the others in logger.test.ts due to
 * pollution of global test state. Running them causes other tests to improperly
 * make requests to braintrust.dev instead of using the test api key.
 */

/* eslint-disable @typescript-eslint/consistent-type-assertions */
import { vi, expect, test, describe, beforeEach, afterEach } from "vitest";
import {
  _exportsForTestingOnly,
  BaseAttachment,
  Attachment,
  ExternalAttachment,
  initDataset,
  initExperiment,
  initLogger,
  login,
  NOOP_SPAN,
  permalink,
  BraintrustState,
} from "./logger";
import { SpanObjectTypeV3 } from "../util/index";
import { LazyValue } from "./util";
import { BackgroundLogEvent, IS_MERGE_FIELD } from "../util/index";
import { configureNode } from "./node/config";

configureNode();

const { extractAttachments, deepCopyEvent, validateTags } =
  _exportsForTestingOnly;

const TEST_API_KEY = "___TEST_API_KEY__THIS_IS_NOT_REAL___";

type HttpLogger = ReturnType<BraintrustState["httpLogger"]>;

function getOnFlushError(bgLogger: HttpLogger) {
  return (
    bgLogger as unknown as {
      onFlushError?: (error: unknown) => void;
    }
  ).onFlushError;
}

function mockFlushFailure(state: BraintrustState, error: Error): HttpLogger {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(state.apiConn(), "get_json").mockResolvedValue({
    logs3_payload_max_bytes: null,
  });

  const bgLogger = state.httpLogger();
  bgLogger.numTries = 1;
  vi.spyOn(
    bgLogger as unknown as {
      submitLogsRequest: () => Promise<void>;
    },
    "submitLogsRequest",
  ).mockRejectedValue(error);
  return bgLogger;
}

function mockExperimentRegister(state: BraintrustState) {
  vi.spyOn(state.appConn(), "post_json").mockImplementation(async (path) => {
    if (path === "api/experiment/register") {
      return {
        project: {
          id: "test-project-id",
          name: "test-project",
        },
        experiment: {
          id: "test-experiment-id",
          name: "test-experiment",
          created: "2024-01-01T00:00:00.000Z",
        },
      };
    }

    throw new Error(`Unexpected app connection request: ${path}`);
  });
}

describe("validateTags", () => {
  test("accepts valid tags", () => {
    expect(() => validateTags(["foo", "bar", "baz"])).not.toThrow();
  });

  test("accepts empty array", () => {
    expect(() => validateTags([])).not.toThrow();
  });

  test("accepts single tag", () => {
    expect(() => validateTags(["solo"])).not.toThrow();
  });

  test("throws on non-string tag", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => validateTags([123 as any])).toThrow("tags must be strings");
  });

  test("throws on duplicate tags", () => {
    expect(() => validateTags(["foo", "bar", "foo"])).toThrow(
      "duplicate tag: foo",
    );
  });

  test("throws on adjacent duplicate tags", () => {
    expect(() => validateTags(["a", "a"])).toThrow("duplicate tag: a");
  });
});

test("extractAttachments no op", () => {
  const attachments: BaseAttachment[] = [];

  extractAttachments({}, attachments);
  expect(attachments).toHaveLength(0);

  const event = { foo: "foo", bar: null, baz: [1, 2, 3] };
  extractAttachments(event, attachments);
  expect(attachments).toHaveLength(0);
  // Same instance.
  expect(event.baz).toBe(event.baz);
  // Same content.
  expect(event).toEqual({ foo: "foo", bar: null, baz: [1, 2, 3] });
});

test("extractAttachments with attachments", () => {
  const attachment1 = new Attachment({
    data: new Blob(["data"]),
    filename: "filename",
    contentType: "text/plain",
  });
  const attachment2 = new Attachment({
    data: new Blob(["data2"]),
    filename: "filename2",
    contentType: "text/plain",
  });
  const attachment3 = new ExternalAttachment({
    url: "s3://bucket/path/to/key.pdf",
    filename: "filename3",
    contentType: "application/pdf",
  });
  const date = new Date();
  const event = {
    foo: "bar",
    baz: [1, 2],
    attachment1,
    attachment3,
    nested: {
      attachment2,
      attachment3,
      info: "another string",
      anArray: [
        attachment1,
        null,
        "string",
        attachment2,
        attachment1,
        attachment3,
        attachment3,
      ],
    },
    null: null,
    undefined: undefined,
    date,
    f: Math.max,
    empty: {},
  };
  const savedNested = event.nested;

  const attachments: BaseAttachment[] = [];
  extractAttachments(event, attachments);

  expect(attachments).toEqual([
    attachment1,
    attachment3,
    attachment2,
    attachment3,
    attachment1,
    attachment2,
    attachment1,
    attachment3,
    attachment3,
  ]);
  expect(attachments[0]).toBe(attachment1);
  expect(attachments[1]).toBe(attachment3);
  expect(attachments[2]).toBe(attachment2);
  expect(attachments[3]).toBe(attachment3);
  expect(attachments[4]).toBe(attachment1);
  expect(attachments[5]).toBe(attachment2);
  expect(attachments[6]).toBe(attachment1);
  expect(attachments[7]).toBe(attachment3);
  expect(attachments[8]).toBe(attachment3);

  expect(event.nested).toBe(savedNested);

  expect(event).toEqual({
    foo: "bar",
    baz: [1, 2],
    attachment1: attachment1.reference,
    attachment3: attachment3.reference,
    nested: {
      attachment2: attachment2.reference,
      attachment3: attachment3.reference,
      info: "another string",
      anArray: [
        attachment1.reference,
        null,
        "string",
        attachment2.reference,
        attachment1.reference,
        attachment3.reference,
        attachment3.reference,
      ],
    },
    null: null,
    undefined: undefined,
    date,
    f: Math.max,
    empty: {},
  });
});

test("deepCopyEvent basic", () => {
  const original: Partial<BackgroundLogEvent> = {
    input: { foo: "bar", null: null, empty: {} },
    output: [1, 2, "3", null, {}],
  };
  const copy = deepCopyEvent(original);
  expect(copy).toEqual(original);
  expect(copy).not.toBe(original);
  expect(copy.input).not.toBe(original.input);
  expect(copy.output).not.toBe(original.output);
});

test.skip("deepCopyEvent with attachments", () => {
  const attachment1 = new Attachment({
    data: new Blob(["data"]),
    filename: "filename",
    contentType: "text/plain",
  });
  const attachment2 = new Attachment({
    data: new Blob(["data2"]),
    filename: "filename2",
    contentType: "text/plain",
  });
  const attachment3 = new ExternalAttachment({
    url: "s3://bucket/path/to/key.pdf",
    filename: "filename3",
    contentType: "application/pdf",
  });
  const date = new Date("2024-10-23T05:02:48.796Z");

  const span = NOOP_SPAN;
  const logger = initLogger();
  const experiment = initExperiment("project");
  const dataset = initDataset({});

  const original = {
    input: "Testing",
    output: {
      span,
      myIllegalObjects: [experiment, dataset, logger],
      myOtherWeirdObjects: [Math.max, date, null, undefined],
      attachment: attachment1,
      another_attachment: attachment3,
      attachmentList: [attachment1, attachment2, "string", attachment3],
      nestedAttachment: {
        attachment: attachment2,
        another_attachment: attachment3,
      },
      fake: {
        _bt_internal_saved_attachment: "not a number",
      },
    },
  };

  const copy = deepCopyEvent(original);

  expect(copy).toEqual({
    input: "Testing",
    output: {
      span: "<span>",
      myIllegalObjects: ["<experiment>", "<dataset>", "<logger>"],
      myOtherWeirdObjects: [null, "2024-10-23T05:02:48.796Z", null, null],
      attachment: attachment1,
      another_attachment: attachment3,
      attachmentList: [attachment1, attachment2, "string", attachment3],
      nestedAttachment: {
        attachment: attachment2,
        another_attachment: attachment3,
      },
      fake: {
        _bt_internal_saved_attachment: "not a number",
      },
    },
  });

  expect(copy).not.toBe(original);

  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any
  expect((copy.output as any).attachment).toBe(attachment1);
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any
  expect((copy.output as any).another_attachment).toBe(attachment3);
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any
  expect((copy.output as any).nestedAttachment.attachment).toBe(attachment2);
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any
  expect((copy.output as any).nestedAttachment.another_attachment).toBe(
    attachment3,
  );
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any
  expect((copy.output as any).attachmentList[0]).toBe(attachment1);
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any
  expect((copy.output as any).attachmentList[1]).toBe(attachment2);
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any
  expect((copy.output as any).attachmentList[3]).toBe(attachment3);
});

describe("span.link", () => {
  beforeEach(() => {
    _exportsForTestingOnly.simulateLogoutForTests();
  });

  afterEach(() => {
    _exportsForTestingOnly.simulateLogoutForTests();
  });

  test("noop span link returns noop permalink", () => {
    const span = NOOP_SPAN;
    const link = span.link();
    expect(link).toBe("https://braintrust.dev/noop-span");
  });

  test("span.link works with project id", async () => {
    // Mock the state for testing - must be done before creating the span
    const state = await _exportsForTestingOnly.simulateLoginForTests();

    // Verify the login was successful
    expect(state.orgName).toBeDefined();
    expect(state.appUrl).toBeDefined();

    // Create a test span
    const logger = initLogger({
      projectName: "test-project",
      projectId: "test-project-id",
    });

    const span = logger.startSpan({ name: "test-span" });
    span.end();

    // Get the link
    const link1 = span.link();
    const link2 = await span.permalink();

    expect(link1).toBe(link2);
  });

  test("span.link works with project name", async () => {
    // Mock the state for testing - must be done before creating the span
    const state = await _exportsForTestingOnly.simulateLoginForTests();
    // Verify the login was successful
    expect(state.orgName).toBeDefined();
    expect(state.appUrl).toBeDefined();
    // Create a test span
    const logger = initLogger({
      projectName: "test-project",
    });
    const span = logger.startSpan({ name: "test-span" });
    span.end();
    // Get the link
    const link1 = span.link();
    expect(link1).toBe(
      // @ts-ignore
      `https://braintrust.dev/app/test-org-name/p/test-project/logs?oid=${span._id}`,
    );
  });

  test("span.link handles missing project name or id", async () => {
    // Mock the state for testing - must be done before creating the span
    const state = await _exportsForTestingOnly.simulateLoginForTests();
    // Verify the login was successful
    expect(state.orgName).toBeDefined();
    expect(state.appUrl).toBeDefined();
    // Create a test span
    const logger = initLogger({});
    const span = logger.startSpan({ name: "test-span" });
    span.end();
    // Get the link
    const link1 = span.link();
    expect(link1).toBe(
      "https://braintrust.dev/error-generating-link?msg=provide-project-name-or-id",
    );
  });

  test("span.link uses BRAINTRUST_ORG_NAME env var when state.orgName not set", () => {
    const originalEnv = process.env.BRAINTRUST_ORG_NAME;
    try {
      // Set env var (beforeEach already ensures logged out state)
      process.env.BRAINTRUST_ORG_NAME = "env-org-name";

      // Create logger with project_id but no login
      const logger = initLogger({ projectId: "test-project-id" });
      const span = logger.startSpan({ name: "test-span" });
      span.end();

      const link = span.link();

      // Should use env var org name
      expect(link).toContain("/app/env-org-name/");
      expect(link).toContain("test-project-id");
    } finally {
      if (originalEnv) {
        process.env.BRAINTRUST_ORG_NAME = originalEnv;
      } else {
        delete process.env.BRAINTRUST_ORG_NAME;
      }
    }
  });

  test("span.link uses orgName passed to initLogger when not logged in", () => {
    // beforeEach already ensures logged out state
    // Create logger with orgName passed directly (no login, no env var)
    const logger = initLogger({
      projectId: "test-project-id",
      orgName: "passed-org-name",
    });
    const span = logger.startSpan({ name: "test-span" });
    span.end();

    const link = span.link();

    // Should use orgName passed to initLogger
    expect(link).toContain("/app/passed-org-name/");
    expect(link).toContain("test-project-id");
  });

  test("span.link uses appUrl passed to initLogger when not logged in", () => {
    // beforeEach sets appUrl to default, clear it to test passed args
    const state = _exportsForTestingOnly.simulateLogoutForTests();
    state.appUrl = null;

    const logger = initLogger({
      projectId: "test-project-id",
      orgName: "test-org",
      appUrl: "https://custom.braintrust.dev",
    });
    const span = logger.startSpan({ name: "test-span" });
    span.end();

    const link = span.link();

    // Should use appUrl passed to initLogger
    expect(link).toContain("https://custom.braintrust.dev/app/test-org/");
  });

  test("span.link works with experiment id", async () => {
    // Mock the state for testing - must be done before creating the span
    const state = await _exportsForTestingOnly.simulateLoginForTests();
    // Verify the login was successful
    expect(state.orgName).toBeDefined();
    expect(state.appUrl).toBeDefined();

    // Create a test experiment
    const experiment = initExperiment("test-experiment");

    // Get a span within the experiment context
    const span = experiment.startSpan({
      name: "test-span",
    });

    span.end();

    const link = span.link();

    // Link should contain experiment ID
    expect(link).toEqual(
      "https://braintrust.dev/error-generating-link?msg=provide-experiment-id",
    );
  });

  test("permalink doesn't error if logged out", async () => {
    _exportsForTestingOnly.simulateLogoutForTests();

    const apiKey = process.env.BRAINTRUST_API_KEY;
    try {
      process.env.BRAINTRUST_API_KEY = "this-is-a-nonsense-api-key";
      // Get a span within the experiment context
      const logger = initLogger({
        projectName: "test-project",
      });
      const span = logger.startSpan({
        name: "test-span",
      });
      span.end();

      const link2 = await span.permalink();
      expect(link2).toBe(
        "https://braintrust.dev/error-generating-link?msg=http-error-401",
      );
    } finally {
      process.env.BRAINTRUST_API_KEY = apiKey;
    }
  });

  test("handles invalid slug format in permalink", async () => {
    const state = await _exportsForTestingOnly.simulateLoginForTests();
    const result = await permalink("invalid-slug", { state });
    expect(result).toContain("https://braintrust.dev/error-generating-link");
  });

  test("span.link handles missing experiment id", async () => {
    const _state = await _exportsForTestingOnly.simulateLoginForTests();
    const experiment = initExperiment("test-experiment");
    const span = experiment.startSpan({ name: "test-span" });
    span.end();
    // Force parentObjectId to be undefined
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (span as any).parentObjectId = { getSync: () => ({ value: undefined }) };
    const link = span.link();
    expect(link).toBe(
      "https://braintrust.dev/error-generating-link?msg=provide-experiment-id",
    );
  });

  test("span.link handles missing project id and name", async () => {
    const _state = await _exportsForTestingOnly.simulateLoginForTests();
    const logger = initLogger({});
    const span = logger.startSpan({ name: "test-span" });
    span.end();
    // Force parentObjectId to be undefined and remove project metadata
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (span as any).parentObjectId = { getSync: () => ({ value: undefined }) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (span as any).parentComputeObjectMetadataArgs = {};
    const link = span.link();
    expect(link).toBe(
      "https://braintrust.dev/error-generating-link?msg=provide-project-name-or-id",
    );
  });

  test("span.link handles playground logs", async () => {
    const _state = await _exportsForTestingOnly.simulateLoginForTests();
    const logger = initLogger({});
    const span = logger.startSpan({ name: "test-span" });
    span.end();
    // Force parentObjectType to be PLAYGROUND_LOGS
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (span as any).parentObjectType = SpanObjectTypeV3.PLAYGROUND_LOGS;
    const link = span.link();
    expect(link).toBe("https://braintrust.dev/noop-span");
  });
});

test("noop span permalink #BRA-1837", async () => {
  const span = NOOP_SPAN;
  const link1 = await span.permalink();
  expect(link1).toBe("https://braintrust.dev/noop-span");

  const slug = await span.export();
  expect(slug).toBe("");

  const link2 = await permalink(slug);
  expect(link2).toBe("https://braintrust.dev/noop-span");
});

test("disable logging", async () => {
  const state = new BraintrustState({});
  const bgLogger = state.bgLogger();

  let submittedItems = [];
  const submitLogsRequestSpy = vi
    // @ts-ignore
    .spyOn(bgLogger, "submitLogsRequest")
    // @ts-ignore
    .mockImplementation((items: string[]) => {
      submittedItems = items;
      return Promise.resolve();
    });

  bgLogger.log([
    new LazyValue(() =>
      Promise.resolve({
        id: "id",
        project_id: "p",
        log_id: "g",
        input: "bar",
        output: "foo",
        [IS_MERGE_FIELD]: false,
      }),
    ),
  ]);

  await bgLogger.flush();
  expect(submitLogsRequestSpy).toHaveBeenCalledTimes(1);
  expect(submittedItems.length).toEqual(1);

  submittedItems = [];
  state.disable();

  for (let i = 0; i < 10; i++) {
    bgLogger.log([
      new LazyValue(() =>
        Promise.resolve({
          id: "id",
          project_id: "p",
          log_id: "g",
          input: "bar" + i,
          output: "foo" + i,
          [IS_MERGE_FIELD]: false,
        }),
      ),
    ]);
  }
  await bgLogger.flush();
  expect(submitLogsRequestSpy).toHaveBeenCalledTimes(1);
  expect(submittedItems.length).toEqual(0);
});

describe("onFlushError wiring", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    _exportsForTestingOnly.simulateLogoutForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _exportsForTestingOnly.simulateLogoutForTests();
  });

  test("initLogger updates an existing background logger callback", async () => {
    const state = new BraintrustState({});
    await state.login({
      apiKey: TEST_API_KEY,
      appUrl: "https://braintrust.dev",
    });
    const flushError = new Error("initLogger flush failure");
    const onFlushError = vi.fn();

    mockFlushFailure(state, flushError);

    const logger = initLogger({
      projectName: "test-project",
      projectId: "test-project-id",
      onFlushError,
      state,
    });

    const span = logger.startSpan({ name: "test-span" });
    span.end();
    await logger.flush();

    expect(onFlushError).toHaveBeenCalledTimes(1);
    expect(onFlushError).toHaveBeenCalledWith(flushError);
  });

  test("login fast path updates an existing background logger callback", async () => {
    const state = await _exportsForTestingOnly.simulateLoginForTests();
    const onFlushError = vi.fn();
    const bgLogger = state.httpLogger();

    await login({
      apiKey: state.loginToken!,
      appUrl: state.appUrl!,
      orgName: state.orgName!,
      onFlushError,
    });

    expect(getOnFlushError(bgLogger)).toBe(onFlushError);
    expect(getOnFlushError(state.httpLogger())).toBe(onFlushError);
  });

  test("initExperiment updates an existing background logger callback", async () => {
    const state = new BraintrustState({});
    await state.login({
      apiKey: TEST_API_KEY,
      appUrl: "https://braintrust.dev",
    });
    const flushError = new Error("initExperiment flush failure");
    const onFlushError = vi.fn();

    mockFlushFailure(state, flushError);
    mockExperimentRegister(state);

    const experiment = initExperiment({
      project: "test-project",
      projectId: "test-project-id",
      experiment: "test-experiment",
      onFlushError,
      repoInfo: {},
      state,
    });

    const span = experiment.startSpan({ name: "test-span" });
    span.end();
    await experiment.flush();

    expect(onFlushError).toHaveBeenCalledTimes(1);
    expect(onFlushError).toHaveBeenCalledWith(flushError);
  });
});
