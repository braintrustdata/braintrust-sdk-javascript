import { describe, test, expect } from "vite-plus/test";
import { mergeRowBatch, batchItems } from "./merge_row_batch";
import { IS_MERGE_FIELD } from "./db_fields";

describe("mergeRowBatch", () => {
  test("basic", () => {
    const rows = [
      // These rows should get merged together, ending up as a merge.
      {
        experiment_id: "e0",
        id: "x",
        inputs: { a: 12 },
        [IS_MERGE_FIELD]: true,
      },
      {
        experiment_id: "e0",
        id: "x",
        inputs: { b: 10 },
        [IS_MERGE_FIELD]: true,
      },
      {
        experiment_id: "e0",
        id: "x",
        inputs: { c: "hello" },
        [IS_MERGE_FIELD]: true,
      },
      // The first row should be clobbered by the second, but the third
      // merged with the second, ending up as a replacement.
      {
        experiment_id: "e0",
        id: "y",
        inputs: { a: "hello" },
      },
      {
        experiment_id: "e0",
        id: "y",
        inputs: { b: 10 },
      },
      {
        experiment_id: "e0",
        id: "y",
        inputs: { c: 12 },
        [IS_MERGE_FIELD]: true,
      },
      // These rows should be clobbered separately from the last batch.
      {
        dataset_id: "d0",
        id: "y",
        inputs: { a: "hello" },
      },
      {
        dataset_id: "d0",
        id: "y",
        inputs: { b: 10 },
      },
      {
        dataset_id: "d0",
        id: "y",
        inputs: { c: 12 },
      },
    ];

    const mergedRows = mergeRowBatch(rows);
    const keyToRows = Object.fromEntries(
      mergedRows.map((row) => [
        JSON.stringify([row.experiment_id, row.dataset_id, row.id]),
        row,
      ]),
    );

    expect(keyToRows).toEqual({
      [JSON.stringify(["e0", undefined, "x"])]: {
        experiment_id: "e0",
        id: "x",
        inputs: { a: 12, b: 10, c: "hello" },
        [IS_MERGE_FIELD]: true,
      },
      [JSON.stringify(["e0", undefined, "y"])]: {
        experiment_id: "e0",
        id: "y",
        inputs: { b: 10, c: 12 },
      },
      [JSON.stringify([undefined, "d0", "y"])]: {
        dataset_id: "d0",
        id: "y",
        inputs: { c: 12 },
      },
    });
  });

  test("skip fields", () => {
    const rows = [
      // These rows should get merged together, ending up as a merge. But
      // the original fields should be retained, regardless of whether we
      // populated them or not.
      {
        experiment_id: "e0",
        id: "x",
        inputs: { a: 12 },
        [IS_MERGE_FIELD]: true,
        created: 123,
        root_span_id: "abc",
        _parent_id: "baz",
        span_parents: ["foo", "bar"],
      },
      {
        experiment_id: "e0",
        id: "x",
        inputs: { b: 10 },
        [IS_MERGE_FIELD]: true,
        created: 456,
        span_id: "foo",
        root_span_id: "bar",
        _parent_id: "boop",
        span_parents: [],
      },
    ];

    const mergedRows = mergeRowBatch(rows);
    expect(mergedRows).toEqual([
      {
        experiment_id: "e0",
        id: "x",
        inputs: { a: 12, b: 10 },
        [IS_MERGE_FIELD]: true,
        created: 123,
        root_span_id: "abc",
        _parent_id: "baz",
        span_parents: ["foo", "bar"],
      },
    ]);
  });
});

describe("batchItems", () => {
  test("basic", () => {
    const a = "x".repeat(1);
    const b = "x".repeat(2);
    const c = "x".repeat(4);
    const d = "y".repeat(1);
    const e = "y".repeat(2);
    const f = "y".repeat(4);

    const items = [a, b, c, f, e, d];

    // No limits.
    let output = batchItems({
      items,
      getByteSize: (item) => item.length,
    });
    expect(output).toEqual([[a, b, c, f, e, d]]);

    // Num items limit.
    output = batchItems({
      items,
      batchMaxNumItems: 2,
      getByteSize: (item) => item.length,
    });
    expect(output).toEqual([
      [a, b],
      [c, f],
      [e, d],
    ]);

    // Num bytes limit.
    output = batchItems({
      items,
      batchMaxNumBytes: 2,
      getByteSize: (item) => item.length,
    });
    expect(output).toEqual([[a], [b], [c], [f], [e], [d]]);

    // Both items and num bytes limit.
    output = batchItems({
      items,
      batchMaxNumItems: 2,
      batchMaxNumBytes: 5,
      getByteSize: (item) => item.length,
    });
    expect(output).toEqual([[a, b], [c], [f], [e, d]]);
  });
});
