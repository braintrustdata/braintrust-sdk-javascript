import { describe, expect, expectTypeOf, test } from "vitest";
import { resolveParentHeader } from "./http_headers";
import {
  SpanComponentsV1,
  SpanObjectTypeV1,
  SpanRowIdsV1,
} from "./span_identifier_v1";
import {
  SpanComponentsV2,
  SpanObjectTypeV2,
  SpanRowIdsV2,
} from "./span_identifier_v2";
import { SpanComponentsV3, SpanObjectTypeV3 } from "./span_identifier_v3";
import { SpanComponentsV4 } from "./span_identifier_v4";

describe("resolveParentHeader", () => {
  const objectId = "a7deedf0-b928-4a1a-81b4-2b7fda03c617";
  const rowId = "1f580643-9202-4b26-a97f-6855ebae398a";

  test("decodes a Python V4 experiment span and preserves its IDs when reserialized", () => {
    // Generated with braintrust==0.45.0 using SpanComponentsV4(**expected).to_str().
    const slug =
      "BAECAwASNFZ4mrzeBACrze8SNFZ4kKvN7xI0Vnh7InByb3BhZ2F0ZWRfZXZlbnQiOnsibWV0YWRhdGEiOnsic291cmNlIjoicHl0aG9uIn19LCJvYmplY3RfaWQiOiJhN2RlZWRmMC1iOTI4LTRhMWEtODFiNC0yYjdmZGEwM2M2MTciLCJyb3dfaWQiOiIxZjU4MDY0My05MjAyLTRiMjYtYTk3Zi02ODU1ZWJhZTM5OGEifQ==";
    const expected = {
      object_type: SpanObjectTypeV3.EXPERIMENT,
      object_id: objectId,
      row_id: rowId,
      span_id: "00123456789abcde",
      root_span_id: "00abcdef1234567890abcdef12345678",
      propagated_event: { metadata: { source: "python" } },
    };

    const parent = resolveParentHeader(slug);
    expectTypeOf(parent).toExtend<SpanComponentsV3>();
    expect(parent.data).toEqual(expected);
    expect(parent.objectIdFields()).toEqual({ experiment_id: objectId });
    expect(SpanComponentsV4.fromStr(parent.toStr()).data).toEqual(expected);
  });

  const legacyIds = {
    rowId,
    spanId: "a146455b-11d3-4c6d-b2ad-8ea813740584",
    rootSpanId: "b04444fb-55ed-40bc-88b5-1390a9ced797",
  };
  const legacyData = {
    object_type: SpanObjectTypeV3.EXPERIMENT,
    object_id: objectId,
    row_id: legacyIds.rowId,
    span_id: legacyIds.spanId,
    root_span_id: legacyIds.rootSpanId,
  };
  const v3Data = {
    ...legacyData,
    span_id: "ABcdEF9876543210",
    root_span_id: "0zabcdef1234567890abcdef12345678",
  };

  test.each([
    {
      version: "V1",
      parent: new SpanComponentsV1({
        objectType: SpanObjectTypeV1.EXPERIMENT,
        objectId,
        rowIds: new SpanRowIdsV1(legacyIds),
      }),
      expected: legacyData,
    },
    {
      version: "V2",
      parent: new SpanComponentsV2({
        objectType: SpanObjectTypeV2.EXPERIMENT,
        objectId,
        rowIds: new SpanRowIdsV2(legacyIds),
      }),
      expected: legacyData,
    },
    { version: "V3", parent: new SpanComponentsV3(v3Data), expected: v3Data },
  ])("decodes and reserializes $version exports", ({ parent, expected }) => {
    const resolved = resolveParentHeader(parent.toStr());
    expect(resolved.data).toMatchObject(expected);
    expect(SpanComponentsV4.fromStr(resolved.toStr()).data).toEqual(expected);
  });

  test.each([
    [
      `experiment_id:${objectId}`,
      { object_type: SpanObjectTypeV3.EXPERIMENT, object_id: objectId },
    ],
    [
      `project_id:${objectId}`,
      { object_type: SpanObjectTypeV3.PROJECT_LOGS, object_id: objectId },
    ],
    [
      "project_name:my project",
      {
        object_type: SpanObjectTypeV3.PROJECT_LOGS,
        compute_object_metadata_args: { project_name: "my project" },
      },
    ],
    [
      `playground_id:${objectId}`,
      { object_type: SpanObjectTypeV3.PLAYGROUND_LOGS, object_id: objectId },
    ],
  ])("resolves the named parent %s", (header, expected) => {
    const parent = resolveParentHeader(header);
    expect(parent.data).toEqual(expected);
    expect(SpanComponentsV4.fromStr(parent.toStr()).data).toEqual(expected);
  });

  test.each([
    ["invalid base64", "invalid-base64!!!"],
    ["an empty header", ""],
    ["an unknown version", btoa("\x05\x01\x00")],
    ["a truncated V4 header", btoa("\x04\x01")],
    ["a truncated V4 field", btoa("\x04\x01\x01\x01")],
  ])("rejects %s", (_, header) => {
    expect(() => resolveParentHeader(header)).toThrow();
  });
});
