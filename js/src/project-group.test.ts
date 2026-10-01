import { afterEach, describe, expect, test, vi } from "vitest";
import {
  BraintrustState,
  init,
  initDataset,
  initLogger,
  spanComponentsToObjectId,
} from "./logger";
import { SpanComponentsV4 } from "../util/span_identifier_v4";
import { _internalInitEvaluatorExperiment } from "./framework";
import { configureNode } from "./node/config";

configureNode();

const projectId = "00000000-0000-0000-0000-000000000001";

function createState() {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = new URL(String(input));
    switch (url.pathname) {
      case "/api/apikey/login":
        return Response.json({
          org_info: [
            { id: "org-id", name: "org-id", api_url: "https://api.test" },
          ],
        });
      case "/api/project/register":
        return Response.json({ project: { id: projectId, name: "project" } });
      case "/api/experiment/register":
        return Response.json({
          project: { id: projectId, name: "project" },
          experiment: { id: "experiment-id", name: "experiment" },
        });
      case "/api/dataset/register":
        return Response.json({
          project: { id: projectId, name: "project" },
          dataset: { id: "dataset-id", name: "dataset" },
        });
      case "/version":
      case "/logs3":
        return Response.json({});
      default:
        throw new Error(`Unexpected test request: ${url.pathname}`);
    }
  });
  const state = new BraintrustState({
    apiKey: "test-credential",
    appUrl: "https://app.test",
    fetch,
    noExitFlush: true,
  });
  return { state, fetch };
}

function bodiesFor(
  fetch: ReturnType<typeof createState>["fetch"],
  pathname: string,
): Record<string, unknown>[] {
  return fetch.mock.calls
    .filter(([url]) => new URL(String(url)).pathname === pathname)
    .map(([, init]) => JSON.parse(String(init?.body)));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("projectGroupName", () => {
  test("initLogger forwards project_group_name to project registration", async () => {
    const { state, fetch } = createState();
    expect(
      await initLogger({
        state,
        projectName: "project",
        projectGroupName: "my-group",
        setCurrent: false,
      }).id,
    ).toBe(projectId);

    expect(bodiesFor(fetch, "/api/project/register")).toEqual([
      {
        project_name: "project",
        org_id: "org-id",
        project_group_name: "my-group",
      },
    ]);
  });

  test("initLogger omits project_group_name when unspecified", async () => {
    const { state, fetch } = createState();
    await initLogger({
      state,
      projectName: "project",
      setCurrent: false,
    }).id;

    const [body] = bodiesFor(fetch, "/api/project/register");
    expect(body).not.toHaveProperty("project_group_name");
  });

  test("project metadata cache keys on the project group name", async () => {
    const { state, fetch } = createState();
    const base = { state, projectName: "project", setCurrent: false };
    await initLogger({ ...base, projectGroupName: "group-a" }).id;
    await initLogger({ ...base, projectGroupName: "group-a" }).id;
    await initLogger({ ...base, projectGroupName: "group-b" }).id;
    await initLogger(base).id;

    expect(
      bodiesFor(fetch, "/api/project/register").map(
        (body) => body.project_group_name,
      ),
    ).toEqual(["group-a", "group-b", undefined]);
  });

  test("init creates the project in the group, then registers by id", async () => {
    const { state, fetch } = createState();
    const experiment = init({
      state,
      project: "project",
      projectGroupName: "my-group",
      experiment: "experiment",
      setCurrent: false,
      baseExperimentId: "base-experiment-id",
      repoInfo: {},
    });
    expect(await experiment.id).toBe("experiment-id");

    expect(bodiesFor(fetch, "/api/project/register")).toEqual([
      {
        project_name: "project",
        org_id: "org-id",
        project_group_name: "my-group",
      },
    ]);
    const [body] = bodiesFor(fetch, "/api/experiment/register");
    expect(body).toMatchObject({ project_id: projectId });
    expect(body).not.toHaveProperty("project_name");
  });

  test("init registers directly when no project group is given", async () => {
    const { state, fetch } = createState();
    await init({
      state,
      project: "project",
      experiment: "experiment",
      setCurrent: false,
      baseExperimentId: "base-experiment-id",
      repoInfo: {},
    }).id;

    expect(bodiesFor(fetch, "/api/project/register")).toEqual([]);
    expect(bodiesFor(fetch, "/api/experiment/register")[0]).toMatchObject({
      project_name: "project",
    });
  });

  test("initDataset creates the project in the group, then registers by id", async () => {
    const { state, fetch } = createState();
    const dataset = initDataset({
      state,
      project: "project",
      projectGroupName: "my-group",
      dataset: "dataset",
    });
    expect(await dataset.id).toBe("dataset-id");

    expect(bodiesFor(fetch, "/api/project/register")).toEqual([
      {
        project_name: "project",
        org_id: "org-id",
        project_group_name: "my-group",
      },
    ]);
    const [body] = bodiesFor(fetch, "/api/dataset/register");
    expect(body).toMatchObject({ project_id: projectId });
    expect(body).not.toHaveProperty("project_name");
  });

  test("projectGroupName is ignored when projectId is specified", async () => {
    const { state, fetch } = createState();
    await initDataset({
      state,
      projectId,
      projectGroupName: "my-group",
      dataset: "dataset",
    }).id;

    expect(bodiesFor(fetch, "/api/project/register")).toEqual([]);
    expect(bodiesFor(fetch, "/api/dataset/register")[0]).toMatchObject({
      project_id: projectId,
    });
  });

  test("Eval creates the project in the group before the experiment", async () => {
    const { state, fetch } = createState();
    const experiment = await _internalInitEvaluatorExperiment(
      "project",
      {
        projectName: "project",
        projectGroupName: "my-group",
        evalName: "eval",
        data: [],
        task: (input: unknown) => input,
        scores: [],
        state,
        baseExperimentId: "base-experiment-id",
        repoInfo: {},
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      [],
    );
    expect(await experiment?.id).toBe("experiment-id");

    expect(bodiesFor(fetch, "/api/project/register")).toEqual([
      {
        project_name: "project",
        org_id: "org-id",
        project_group_name: "my-group",
      },
    ]);
    expect(bodiesFor(fetch, "/api/experiment/register")[0]).toMatchObject({
      project_id: projectId,
    });
  });

  test("exported span components carry the project group for lazy resolution", async () => {
    const { state, fetch } = createState();
    const logger = initLogger({
      state,
      projectName: "project",
      projectGroupName: "my-group",
      setCurrent: false,
    });

    // The logger has not resolved its id yet, so `export()` defers project
    // resolution (and creation) to whoever consumes the exported components.
    const components = SpanComponentsV4.fromStr(await logger.export());
    expect(components.data.compute_object_metadata_args).toMatchObject({
      project_name: "project",
      project_group_name: "my-group",
    });

    expect(await spanComponentsToObjectId({ components, state })).toBe(
      projectId,
    );
    expect(bodiesFor(fetch, "/api/project/register")).toEqual([
      {
        project_name: "project",
        org_id: "org-id",
        project_group_name: "my-group",
      },
    ]);
  });
});
