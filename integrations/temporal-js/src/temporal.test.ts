import { expect, test, describe } from "vitest";
import {
  serializeHeaderValue,
  deserializeHeaderValue,
  BRAINTRUST_SPAN_HEADER,
  BRAINTRUST_WORKFLOW_SPAN_HEADER,
  BRAINTRUST_WORKFLOW_SPAN_ID_HEADER,
} from "./utils";
import {
  SpanComponentsV3,
  SpanComponentsV4,
  SpanObjectTypeV3,
} from "braintrust/util";
import {
  BraintrustTemporalPlugin,
  createBraintrustTemporalPlugin,
} from "./plugin";

describe("temporal header utilities", () => {
  test("serializeHeaderValue encodes string correctly", () => {
    const value = "test-span-id";
    const payload = serializeHeaderValue(value);

    expect(payload.metadata?.encoding).toBeDefined();
    expect(payload.data).toBeDefined();
    expect(new TextDecoder().decode(payload.metadata?.encoding)).toBe(
      "json/plain",
    );
    expect(new TextDecoder().decode(payload.data)).toBe('"test-span-id"');
  });

  test("deserializeHeaderValue decodes payload correctly", () => {
    const original = "test-value-123";
    const payload = serializeHeaderValue(original);
    const decoded = deserializeHeaderValue(payload);

    expect(decoded).toBe(original);
  });

  test("deserializeHeaderValue handles undefined payload", () => {
    expect(deserializeHeaderValue(undefined)).toBeUndefined();
  });

  test("deserializeHeaderValue handles payload without data", () => {
    expect(deserializeHeaderValue({ metadata: {} })).toBeUndefined();
  });

  test("deserializeHeaderValue handles invalid JSON", () => {
    const payload = {
      data: new TextEncoder().encode("not valid json"),
    };
    expect(deserializeHeaderValue(payload)).toBeUndefined();
  });

  test("round-trip serialization preserves complex strings", () => {
    const testCases = [
      "simple",
      "with spaces",
      "with/slashes",
      "unicode-日本語",
      "emoji-👋",
      "",
    ];

    for (const value of testCases) {
      const payload = serializeHeaderValue(value);
      const decoded = deserializeHeaderValue(payload);
      expect(decoded).toBe(value);
    }
  });

  test("header constants are defined", () => {
    expect(BRAINTRUST_SPAN_HEADER).toBe("_braintrust-span");
    expect(BRAINTRUST_WORKFLOW_SPAN_HEADER).toBe("_braintrust-workflow-span");
    expect(BRAINTRUST_WORKFLOW_SPAN_ID_HEADER).toBe(
      "_braintrust-workflow-span-id",
    );
  });
});

describe("SpanComponentsV4 cross-worker reconstruction", () => {
  test("can parse and reconstruct V4 span components with new span_id", () => {
    const clientComponents = new SpanComponentsV4({
      object_type: SpanObjectTypeV3.PROJECT_LOGS,
      object_id: "project-123",
      row_id: "row-456",
      span_id: "1234567890abcdef",
      root_span_id: "1234567890abcdef1234567890abcdef",
    });

    const clientContext = clientComponents.toStr();
    const workflowSpanId = "workflow-span-id";

    const parsed = SpanComponentsV4.fromStr(clientContext);
    const data = parsed.data;

    expect(data.row_id).toBe("row-456");
    expect(data.root_span_id).toBe("1234567890abcdef1234567890abcdef");
    expect(data.span_id).toBe("1234567890abcdef");

    if (data.row_id && data.root_span_id) {
      const workflowComponents = new SpanComponentsV4({
        object_type: data.object_type,
        object_id: data.object_id,
        propagated_event: data.propagated_event,
        row_id: workflowSpanId,
        root_span_id: data.root_span_id,
        span_id: workflowSpanId,
      });

      const reconstructed = SpanComponentsV4.fromStr(
        workflowComponents.toStr(),
      );
      expect(reconstructed.data.span_id).toBe(workflowSpanId);
      expect(reconstructed.data.row_id).toBe(workflowSpanId);
      expect(reconstructed.data.root_span_id).toBe(
        "1234567890abcdef1234567890abcdef",
      );
      expect(reconstructed.data.object_id).toBe("project-123");
    }
  });

  test("can parse legacy V3 client context and reconstruct V4 parent", () => {
    const clientComponents = new SpanComponentsV3({
      object_type: SpanObjectTypeV3.PROJECT_LOGS,
      object_id: "project-123",
      row_id: "row-456",
      span_id: "client-span-id",
      root_span_id: "root-span-id",
    });

    const parsed = SpanComponentsV4.fromStr(clientComponents.toStr());
    const workflowComponents = new SpanComponentsV4({
      object_type: parsed.data.object_type,
      object_id: parsed.data.object_id,
      propagated_event: parsed.data.propagated_event,
      row_id: "workflow-span-id",
      root_span_id: parsed.data.root_span_id!,
      span_id: "workflow-span-id",
    });

    const reconstructed = SpanComponentsV4.fromStr(workflowComponents.toStr());
    expect(reconstructed.data.span_id).toBe("workflow-span-id");
    expect(reconstructed.data.row_id).toBe("workflow-span-id");
    expect(reconstructed.data.root_span_id).toBe("root-span-id");
    expect(reconstructed.data.object_id).toBe("project-123");
  });

  test("preserves object_type when reconstructing", () => {
    const objectTypes = [
      SpanObjectTypeV3.PROJECT_LOGS,
      SpanObjectTypeV3.EXPERIMENT,
      SpanObjectTypeV3.PLAYGROUND_LOGS,
    ];

    for (const objectType of objectTypes) {
      const original = new SpanComponentsV4({
        object_type: objectType,
        object_id: "test-id",
        row_id: "row-id",
        span_id: "original-span-id",
        root_span_id: "root-span-id",
      });

      const parsed = SpanComponentsV4.fromStr(original.toStr());

      const reconstructed = new SpanComponentsV4({
        object_type: parsed.data.object_type,
        object_id: parsed.data.object_id,
        propagated_event: parsed.data.propagated_event,
        row_id: parsed.data.row_id!,
        root_span_id: parsed.data.root_span_id!,
        span_id: "new-span-id",
      });

      expect(reconstructed.data.object_type).toBe(objectType);
    }
  });

  test("handles span components without row_id fields", () => {
    const componentsWithoutRowId = new SpanComponentsV4({
      object_type: SpanObjectTypeV3.PROJECT_LOGS,
      object_id: "test-id",
    });

    const parsed = SpanComponentsV4.fromStr(componentsWithoutRowId.toStr());

    expect(parsed.data.row_id).toBeUndefined();
    expect(parsed.data.span_id).toBeUndefined();
    expect(parsed.data.root_span_id).toBeUndefined();
  });

  test("preserves propagated_event when reconstructing", () => {
    const propagatedEvent = { key: "value", nested: { inner: 123 } };

    const original = new SpanComponentsV4({
      object_type: SpanObjectTypeV3.PROJECT_LOGS,
      object_id: "test-id",
      propagated_event: propagatedEvent,
      row_id: "row-id",
      span_id: "original-span-id",
      root_span_id: "root-span-id",
    });

    const parsed = SpanComponentsV4.fromStr(original.toStr());

    const reconstructed = new SpanComponentsV4({
      object_type: parsed.data.object_type,
      object_id: parsed.data.object_id,
      propagated_event: parsed.data.propagated_event,
      row_id: parsed.data.row_id!,
      root_span_id: parsed.data.root_span_id!,
      span_id: "new-span-id",
    });

    expect(reconstructed.data.propagated_event).toEqual(propagatedEvent);
  });
});

describe("BraintrustTemporalPlugin", () => {
  test("createBraintrustTemporalPlugin returns a plugin instance", () => {
    const plugin = createBraintrustTemporalPlugin();
    expect(plugin).toBeInstanceOf(BraintrustTemporalPlugin);
    expect(plugin.name).toBe("braintrust");
  });

  test("plugin has configureClient method", () => {
    const plugin = createBraintrustTemporalPlugin();
    expect(typeof plugin.configureClient).toBe("function");
  });

  test("plugin has configureWorker method", () => {
    const plugin = createBraintrustTemporalPlugin();
    expect(typeof plugin.configureWorker).toBe("function");
  });

  test("configureClient adds workflow interceptor", () => {
    const plugin = createBraintrustTemporalPlugin();
    const options = {};
    const configured = plugin.configureClient(options);

    expect(configured.interceptors).toBeDefined();
    expect(configured.interceptors?.workflow).toBeDefined();
    expect(Array.isArray(configured.interceptors?.workflow)).toBe(true);
    expect((configured.interceptors?.workflow as any[]).length).toBe(1);
  });

  test("configureClient preserves existing interceptors", () => {
    const plugin = createBraintrustTemporalPlugin();
    const existingInterceptor = { start: async (i: unknown, n: unknown) => n };
    const options = {
      interceptors: {
        workflow: [existingInterceptor],
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const configured = plugin.configureClient(options as any);

    expect((configured.interceptors?.workflow as any[]).length).toBe(2);
  });

  test("configureWorker adds activity interceptor and sinks", () => {
    const plugin = createBraintrustTemporalPlugin();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const options = {} as any;
    const configured = plugin.configureWorker(options);

    expect(configured.interceptors).toBeDefined();
    expect(configured.interceptors?.activity).toBeDefined();
    expect(Array.isArray(configured.interceptors?.activity)).toBe(true);
    expect(configured.interceptors?.activity?.length).toBe(1);
    expect(configured.sinks).toBeDefined();
    expect(configured.sinks?.braintrust).toBeDefined();
  });
});
