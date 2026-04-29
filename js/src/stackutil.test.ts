import { expect, test } from "vitest";
import {
  callerFromAnonymousFunction,
  callerFromModuleInit,
  callerFromNamedFunction,
} from "../tests/helpers/stackutil-caller";

function normalizeFileName(fileName: string) {
  return fileName.replace(/^file:\/\//, "");
}

test("getCallerLocation works with a real top-level caller frame", () => {
  expect(callerFromModuleInit).toBeDefined();
  expect(callerFromModuleInit!.caller_lineno).toBeGreaterThan(1);
  expect(normalizeFileName(callerFromModuleInit!.caller_filename)).toMatch(
    /tests[\\/]helpers[\\/]stackutil-caller\.(ts|js)$/,
  );
});

test("getCallerLocation works with a real named function caller frame", () => {
  const location = callerFromNamedFunction();
  expect(location).toBeDefined();
  expect(location!.caller_lineno).toBeGreaterThan(1);
  expect(normalizeFileName(location!.caller_filename)).toMatch(
    /tests[\\/]helpers[\\/]stackutil-caller\.(ts|js)$/,
  );
  expect(location!.caller_functionname).toContain("callerFromNamedFunction");
});

test("getCallerLocation works with a real anonymous function caller frame", () => {
  const location = callerFromAnonymousFunction();
  expect(location).toBeDefined();
  expect(location!.caller_lineno).toBeGreaterThan(1);
  expect(normalizeFileName(location!.caller_filename)).toMatch(
    /tests[\\/]helpers[\\/]stackutil-caller\.(ts|js)$/,
  );
});
