import { expect, test } from "vitest";

import { SpanComponentsV3, SpanObjectTypeV3 } from "./span_identifier_v3";

test("V3 span identifiers preserve optional trace flags", () => {
  const serialized = new SpanComponentsV3({
    object_type: SpanObjectTypeV3.PROJECT_LOGS,
    object_id: "project-123",
    row_id: "row-456",
    span_id: "span-789",
    root_span_id: "root-012",
    trace_flags: "00",
  }).toStr();

  expect(SpanComponentsV3.fromStr(serialized).data.trace_flags).toBe("00");
});
