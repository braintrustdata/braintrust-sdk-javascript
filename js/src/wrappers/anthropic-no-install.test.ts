import { test, expect } from "vitest";
import { wrapAnthropic } from "./anthropic";

test("wrapAnthropic works even if not installed", () => {
  expect(wrapAnthropic).toBeDefined();
  expect(wrapAnthropic).toBeInstanceOf(Function);

  try {
    const Anthropic = require("@anthropic-ai/sdk");
  } catch (e) {
    // anthropic should not be installed when this test runs
    // so make sure it's a no-op
    const x = { 1: 2 };
    const y = wrapAnthropic(x);
    expect(y).toBe(x);
  }
});
