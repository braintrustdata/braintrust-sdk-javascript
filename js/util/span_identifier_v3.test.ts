import { describe, expect, test } from "vitest";

import { projectLogsIdentifier } from "./span_identifier_v3";

describe("projectLogsIdentifier", () => {
  test("prefers an explicit object id", () => {
    expect(
      projectLogsIdentifier("object-id", {
        project_id: "metadata-id",
        project_name: "project-name",
      }),
    ).toEqual({ kind: "object_id", objectId: "object-id" });
  });

  test("prefers a project id over a project name", () => {
    expect(
      projectLogsIdentifier(undefined, {
        project_id: "metadata-id",
        project_name: "project-name",
      }),
    ).toEqual({ kind: "object_id", objectId: "metadata-id" });
  });

  test("resolves a project name", () => {
    expect(
      projectLogsIdentifier(undefined, {
        project_id: null,
        project_name: "project-name",
      }),
    ).toEqual({ kind: "project_name", projectName: "project-name" });
  });

  test("ignores unknown metadata fields", () => {
    expect(
      projectLogsIdentifier(undefined, {
        project_name: "project-name",
        other: "value",
      }),
    ).toEqual({ kind: "project_name", projectName: "project-name" });
  });

  test("returns undefined for empty or malformed metadata", () => {
    expect(projectLogsIdentifier(undefined, undefined)).toBeUndefined();
    expect(projectLogsIdentifier(undefined, {})).toBeUndefined();
    expect(
      projectLogsIdentifier(undefined, {
        project_id: "",
        project_name: "",
      }),
    ).toBeUndefined();
    expect(
      projectLogsIdentifier(undefined, {
        project_id: 42,
        project_name: "project-name",
      }),
    ).toBeUndefined();
  });
});
