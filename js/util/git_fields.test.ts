import { describe, expect, test } from "vitest";
import { defaultGitMetadataSettings } from "./git_fields";

describe("defaultGitMetadataSettings", () => {
  test("excludes git diff by default", () => {
    expect(defaultGitMetadataSettings()).toEqual({
      collect: "some",
      fields: [
        "commit",
        "branch",
        "tag",
        "dirty",
        "author_name",
        "author_email",
        "commit_message",
        "commit_time",
      ],
    });
  });

  test("returns a fresh fields array", () => {
    const settings = defaultGitMetadataSettings();
    settings.fields?.push("git_diff");

    expect(defaultGitMetadataSettings().fields).not.toContain("git_diff");
  });
});
