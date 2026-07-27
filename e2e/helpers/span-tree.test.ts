import { describe, expect, test } from "vitest";
import type { CapturedLogEvent } from "./mock-braintrust-server";
import { formatSpanTreeJsonSnapshot } from "./span-tree";

function spanEvent(args: {
  id: string;
  name: string;
  parentIds?: string[];
  start?: number;
}): CapturedLogEvent {
  return {
    apiVersion: 2,
    isMerge: false,
    metrics: args.start === undefined ? undefined : { start: args.start },
    row: {},
    span: {
      ended: true,
      id: args.id,
      name: args.name,
      parentIds: args.parentIds ?? [],
      started: true,
    },
  };
}

describe("span tree ordering", () => {
  test("preserves capture order", () => {
    const snapshot = JSON.parse(
      formatSpanTreeJsonSnapshot([
        spanEvent({
          id: "later",
          name: "later",
          parentIds: ["root"],
          start: 3,
        }),
        spanEvent({
          id: "earlier",
          name: "earlier",
          parentIds: ["root"],
          start: 2,
        }),
        spanEvent({ id: "root", name: "root", start: 1 }),
      ]),
    ) as {
      span_tree: Array<{ children: Array<{ name: string }> }>;
    };

    expect(snapshot.span_tree[0]?.children.map(({ name }) => name)).toEqual([
      "later",
      "earlier",
    ]);
  });
});
