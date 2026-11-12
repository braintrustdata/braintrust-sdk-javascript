import { expect, test } from "vite-plus/test";
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
