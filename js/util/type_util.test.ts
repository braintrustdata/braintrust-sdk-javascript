import { describe, expect, test } from "vitest";
import * as vm from "node:vm";
import { isObject, isObjectOrArray } from "./type_util";

describe("type_util realm-safe object guards", () => {
  test("isObject accepts plain objects from another vm context", () => {
    const crossRealmObject = vm.runInNewContext("({ answer: 42 })");

    expect(isObject(crossRealmObject)).toBe(true);
  });

  test("isObjectOrArray accepts arrays from another vm context", () => {
    const crossRealmArray = vm.runInNewContext("[1, 2, 3]");

    expect(isObjectOrArray(crossRealmArray)).toBe(true);
  });
});
