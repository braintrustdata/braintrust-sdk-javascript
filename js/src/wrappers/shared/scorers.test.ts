import { afterEach, expect, test, vi } from "vitest";
import { NOOP_SPAN } from "../../logger";
import { runScorers } from "./scorers";
import type { ScorerFunction } from "./types";

afterEach(() => vi.restoreAllMocks());

test.each<ScorerFunction>([
  () => ({ score: 0.8, metadata: { reason: "test" } }),
  async () => ({ score: 0.8, metadata: { reason: "test" } }),
])("test runner scorers accept nameless objects", async (scorer) => {
  const log = vi.spyOn(NOOP_SPAN, "log");
  await runScorers({
    scorers: [scorer],
    input: "hello",
    output: "hello",
    expected: "hello",
    metadata: undefined,
    span: NOOP_SPAN,
  });
  expect(log).toHaveBeenCalledWith({
    scores: { score: 0.8 },
    metadata: { reason: "test" },
  });
});
