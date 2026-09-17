import { expect, test } from "vitest";
import { deterministicReplacer } from "./json_util";

test("deterministicReplacer basic", () => {
  const obj = {
    c: "hello",
    a: { q: 99, d: null },
    b: [9, { c: "yes", d: "no" }, { d: "yes", c: "no" }],
  };
  const obj2 = {
    b: [9, { d: "no", c: "yes" }, { c: "no", d: "yes" }],
    a: { d: null, q: 99 },
    c: "hello",
  };
  expect(obj).toEqual(obj2);

  expect(JSON.stringify(obj)).not.toEqual(JSON.stringify(obj2));
  expect(JSON.stringify(obj, deterministicReplacer)).toEqual(
    JSON.stringify(obj2, deterministicReplacer),
  );
});

test("deterministicReplacer handles prototype keys safely", () => {
  const value = JSON.parse('{"z":1,"__proto__":{"polluted":true},"a":2}');

  expect(JSON.stringify(value, deterministicReplacer)).toBe(
    '{"__proto__":{"polluted":true},"a":2,"z":1}',
  );
  expect(Object.prototype).not.toHaveProperty("polluted");
});
