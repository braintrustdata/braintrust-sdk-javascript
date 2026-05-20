import { expect, test, describe, afterEach } from "vitest";
import {
  mapAt,
  forEachMissingKey,
  mergeDicts,
  mergeDictsWithPaths,
} from "./object_util";

function makeAccumulateMissingKeysF() {
  const missingKeys: Record<string, string[]> = {};
  function fn({ k, path }: { k: string; path: string[] }) {
    missingKeys[k] = path;
  }
  return { missingKeys, fn };
}

test("forEachMissingKey basic", () => {
  let lhs = { a: 4, b: "hello", c: { d: "what" }, x: [1, 2, 3] };
  let rhs = { b: lhs.b, q: "hi", c: { e: "yes" }, x: [6, 7, 8, 9] };

  let keysAndFn = makeAccumulateMissingKeysF();
  forEachMissingKey({ lhs, rhs, fn: keysAndFn.fn });
  expect(keysAndFn.missingKeys).toEqual({ q: [], e: ["c"], 3: ["x"] });
});

test("forEachMissingKey structural mismatch", () => {
  let lhs = { a: 4, c: { d: "what" }, x: [1, 2, 3] };
  let rhs: Record<string, any> = { q: "hi", c: "dog", x: { dog: "cat" } };

  let keysAndFn = makeAccumulateMissingKeysF();
  forEachMissingKey({ lhs, rhs, fn: keysAndFn.fn });
  expect(keysAndFn.missingKeys).toEqual({ q: [], dog: ["x"] });
});

test("mergeDicts basic", () => {
  let a = {
    x: 10,
    y: "hello",
    z: {
      a: "yes",
      b: "no",
      c: [1, 2, 3],
    },
    n: { a: 12 },
  };
  let b = {
    y: "goodbye",
    q: "new",
    z: {
      b: "maybe",
      c: 99,
      d: "something",
    },
    n: null,
  };
  mergeDicts(a, b);
  expect(a).toEqual({
    x: 10,
    y: "goodbye",
    z: {
      a: "yes",
      b: "maybe",
      c: 99,
      d: "something",
    },
    n: null,
    q: "new",
  });
});

test("mergeDictsWithPaths", () => {
  function ab() {
    return [
      {
        x: 10,
        y: "hello",
        z: {
          a: "yes",
          b: "no",
          c: [1, 2, 3],
        },
        n: { a: 12 },
      },
      {
        y: "goodbye",
        q: "new",
        z: {
          b: "maybe",
          c: 99,
          d: "something",
        },
        n: null,
      },
    ];
  }

  let fullMerge: Record<string, unknown>,
    a: Record<string, unknown>,
    b: Record<string, unknown>;
  [fullMerge, b] = ab();
  mergeDicts(fullMerge, b);

  [a, b] = ab();
  mergeDictsWithPaths({ mergeInto: a, mergeFrom: b, mergePaths: [] });
  expect(a).toEqual(fullMerge);

  [a, b] = ab();
  mergeDictsWithPaths({ mergeInto: a, mergeFrom: b, mergePaths: [["z"]] });
  expect(a).toEqual({
    x: 10,
    y: "goodbye",
    z: { b: "maybe", c: 99, d: "something" },
    n: null,
    q: "new",
  });

  [a, b] = ab();
  a["a"] = { y: { a: 10, b: 20 } };
  b["a"] = { y: { a: 20, c: 30 } };
  mergeDictsWithPaths({
    mergeInto: a,
    mergeFrom: b,
    mergePaths: [["z"], ["a", "y"]],
  });
  expect(a).toEqual({
    x: 10,
    y: "goodbye",
    z: { b: "maybe", c: 99, d: "something" },
    n: null,
    q: "new",
    a: { y: { a: 20, c: 30 } },
  });

  [a, b] = ab();
  mergeDictsWithPaths({ mergeInto: a, mergeFrom: b, mergePaths: [["z", "b"]] });
  expect(a).toEqual(fullMerge);
});

test("mergeDictsWithPaths ignore undefined", () => {
  function ab() {
    return [
      {
        x: 10,
        y: "hello",
        z: {
          a: "yes",
          b: "no",
        },
        n: { a: 12 },
      },
      {
        y: "goodbye",
        q: "new",
        z: {
          a: undefined,
          b: "maybe",
        },
        n: undefined,
      },
    ];
  }

  let a: Record<string, unknown>, b: Record<string, unknown>;
  [a, b] = ab();
  mergeDicts(a, b);
  expect(a).toEqual({
    x: 10,
    y: "goodbye",
    q: "new",
    z: {
      a: "yes",
      b: "maybe",
    },
    n: { a: 12 },
  });
});

test("mapAt basic", () => {
  const m = new Map<number, string>([
    [4, "hello"],
    [5, "goodbye"],
  ]);
  expect(mapAt(m, 4)).toBe("hello");
  expect(mapAt(m, 5)).toBe("goodbye");
  expect(() => mapAt(m, 6)).toThrowError("Map does not contain key 6");
});

describe("tags set-union merge", () => {
  test("tags arrays are merged as sets by default", () => {
    const a = { tags: ["a", "b"] };
    const b = { tags: ["b", "c"] };
    mergeDictsWithPaths({ mergeInto: a, mergeFrom: b, mergePaths: [] });
    expect(a.tags).toEqual(["a", "b", "c"]);
  });

  test("tags merge deduplicates values", () => {
    const a = { tags: ["a", "b", "c"] };
    const b = { tags: ["a", "b", "c", "d"] };
    mergeDictsWithPaths({ mergeInto: a, mergeFrom: b, mergePaths: [] });
    expect(a.tags).toEqual(["a", "b", "c", "d"]);
  });

  test("tags merge works when mergeInto has no tags", () => {
    const a: Record<string, unknown> = { other: "data" };
    const b = { tags: ["a", "b"] };
    mergeDictsWithPaths({ mergeInto: a, mergeFrom: b, mergePaths: [] });
    expect(a.tags).toEqual(["a", "b"]);
  });

  test("tags merge works when mergeFrom has no tags", () => {
    const a = { tags: ["a", "b"] };
    const b: Record<string, unknown> = { other: "data" };
    mergeDictsWithPaths({ mergeInto: a, mergeFrom: b, mergePaths: [] });
    expect(a.tags).toEqual(["a", "b"]);
  });

  test("tags are replaced when included in mergePaths", () => {
    const a = { tags: ["a", "b"] };
    const b = { tags: ["c", "d"] };
    mergeDictsWithPaths({ mergeInto: a, mergeFrom: b, mergePaths: [["tags"]] });
    expect(a.tags).toEqual(["c", "d"]);
  });

  test("empty tags array clears tags", () => {
    const a = { tags: ["a", "b"] };
    const b = { tags: [] as string[] };
    mergeDictsWithPaths({ mergeInto: a, mergeFrom: b, mergePaths: [["tags"]] });
    expect(a.tags).toEqual([]);
  });

  test("null tags replaces tags", () => {
    const a: Record<string, unknown> = { tags: ["a", "b"] };
    const b: Record<string, unknown> = { tags: null };
    mergeDictsWithPaths({ mergeInto: a, mergeFrom: b, mergePaths: [] });
    expect(a.tags).toEqual(null);
  });

  test("set-union only applies to top-level tags field", () => {
    const a = { metadata: { tags: ["a", "b"] } };
    const b = { metadata: { tags: ["c", "d"] } };
    mergeDictsWithPaths({ mergeInto: a, mergeFrom: b, mergePaths: [] });
    expect(a.metadata.tags).toEqual(["c", "d"]);
  });
});

describe("mergeDicts prototype pollution resistance", () => {
  const POLLUTION_KEY = "polluted";

  afterEach(() => {
    Reflect.deleteProperty(Object.prototype, POLLUTION_KEY);
  });

  test.each([
    {
      name: "__proto__ at top level",
      payload: '{"__proto__":{"polluted":"yes"}}',
    },
    {
      name: "nested __proto__",
      payload: '{"a":{"__proto__":{"polluted":"yes"}}}',
    },
    {
      name: "constructor.prototype",
      payload: '{"constructor":{"prototype":{"polluted":"yes"}}}',
    },
    {
      name: "top-level prototype",
      payload: '{"prototype":{"polluted":"yes"}}',
    },
  ])("mergeDicts ignores $name", ({ payload }) => {
    const target: Record<string, unknown> = {};
    mergeDicts(target, JSON.parse(payload));
    expect(Object.prototype).not.toHaveProperty(POLLUTION_KEY);
    expect(target).not.toHaveProperty(POLLUTION_KEY);
  });

  test("nested __proto__ leaves the legitimate subtree intact", () => {
    const target: Record<string, unknown> = { a: { b: 1 } };
    mergeDicts(target, JSON.parse('{"a":{"__proto__":{"polluted":"yes"}}}'));
    expect(target).toEqual({ a: { b: 1 } });
  });

  test("forbidden key alongside safe key only drops the forbidden one", () => {
    const target: Record<string, unknown> = {};
    mergeDictsWithPaths({
      mergeInto: target,
      mergeFrom: JSON.parse('{"safe":1,"__proto__":{"polluted":"yes"}}'),
      mergePaths: [],
    });
    expect(target).toEqual({ safe: 1 });
    expect(Object.prototype).not.toHaveProperty(POLLUTION_KEY);
  });
});
