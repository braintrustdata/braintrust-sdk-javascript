import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  getChangesetSummary,
  isConventionalCommitSummary,
} from "./validate-changesets.mjs";

describe("getChangesetSummary", () => {
  test("returns the first non-empty line after frontmatter", () => {
    assert.equal(
      getChangesetSummary(`---
"braintrust": minor
---

feat(js)!: add a feature

More detail.
`),
      "feat(js)!: add a feature",
    );
  });

  test("rejects missing frontmatter or summary", () => {
    assert.equal(getChangesetSummary("feat: add a feature\n"), undefined);
    assert.equal(
      getChangesetSummary(`---
"braintrust": patch
---
`),
      undefined,
    );
  });
});

describe("isConventionalCommitSummary", () => {
  test("accepts valid Conventional Commit summaries", () => {
    for (const summary of [
      "feat: add a feature",
      "fix(js): repair batch uploads",
      "refactor(parser)!: replace the parser",
      "REVERT: restore the previous behavior",
    ]) {
      assert.equal(isConventionalCommitSummary(summary), true, summary);
    }
  });

  test("rejects invalid Conventional Commit summaries", () => {
    for (const summary of [
      "Add a feature",
      "feat add a feature",
      "feat:add a feature",
      "feat:  add a feature",
      "feat(): add a feature",
      "feat(scope with spaces): add a feature",
      "feat: ",
    ]) {
      assert.equal(isConventionalCommitSummary(summary), false, summary);
    }
  });
});
