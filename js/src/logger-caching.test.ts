import { afterEach, describe, expect, test, vi } from "vitest";
import {
  BraintrustState,
  initLogger,
  spanComponentsToObjectId,
  startSpan,
  updateSpan,
  _internalResumeSpan,
} from "./logger";
import { configureNode } from "./node/config";
import iso from "./isomorph";
import { SpanComponentsV4 } from "../util/span_identifier_v4";

configureNode();

const projectId = "00000000-0000-0000-0000-000000000001";
const ttl = 15 * 60 * 1000;

function loginResponse(orgId = "org-id") {
  return Response.json({
    org_info: [{ id: orgId, name: orgId, api_url: "https://api.test" }],
  });
}

function createState() {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = new URL(String(input));
    switch (url.pathname) {
      case "/api/apikey/login":
        return loginResponse();
      case "/api/project/register":
        return Response.json({ project: { id: projectId, name: "project" } });
      case "/api/project":
        return Response.json({
          name: "project",
          project: { id: url.searchParams.get("id"), name: "project" },
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

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("project metadata caching", () => {
  test.each(["reset", "forceLogin", "fetch"])(
    "shares lookups across SDK copies and invalidates on %s",
    async (action) => {
      vi.resetModules();
      const otherSdk = await import("./logger");
      const otherNode = await import("./node/config");
      otherNode.configureNode();

      const { state, fetch } = createState();
      const options = { state, projectName: "project", setCurrent: false };
      expect(
        await Promise.all([
          initLogger(options).id,
          otherSdk.initLogger(options).id,
        ]),
      ).toEqual([projectId, projectId]);
      expect(
        fetch.mock.calls.filter(([url]) =>
          String(url).endsWith("/api/project/register"),
        ),
      ).toHaveLength(1);

      if (action === "reset") {
        state.resetLoginInfo();
        await state.login({});
      } else if (action === "forceLogin") {
        await state.login({ forceLogin: true });
      } else {
        state.setFetch((...args) => fetch(...args));
      }
      fetch.mockResolvedValueOnce(
        Response.json({ project: { id: "replacement-id", name: "project" } }),
      );
      expect(await otherSdk.initLogger(options).id).toBe("replacement-id");
      expect(await initLogger(options).id).toBe("replacement-id");
      expect(
        fetch.mock.calls.filter(([url]) =>
          String(url).endsWith("/api/project/register"),
        ),
      ).toHaveLength(2);
    },
  );

  test.each(["name", "id"])(
    "isolates metadata mutations across concurrent and later %s lookups",
    async (lookup) => {
      const { state, fetch } = createState();
      await state.login({});
      const project = {
        id: projectId,
        name: "project",
        metadata: { labels: ["original"] },
      };
      fetch.mockResolvedValueOnce(Response.json({ name: "project", project }));
      const options = {
        state,
        setCurrent: false,
        ...(lookup === "name" ? { projectName: "project" } : { projectId }),
      };
      const first = initLogger(options);
      const second = initLogger(options);
      const [firstProject, secondProject] = await Promise.all([
        first.project,
        second.project,
      ]);
      firstProject.id = "changed-id";
      firstProject.name = "changed-name";
      (firstProject.fullInfo.metadata as typeof project.metadata).labels.push(
        "changed",
      );
      expect(secondProject).toEqual({
        id: projectId,
        name: "project",
        fullInfo: project,
      });
      expect(await second.id).toBe(projectId);
      secondProject.id = "also-changed";
      (secondProject.fullInfo.metadata as typeof project.metadata).labels.push(
        "also-changed",
      );
      expect(await initLogger(options).project).toEqual({
        id: projectId,
        name: "project",
        fullInfo: project,
      });
      const components = SpanComponentsV4.fromStr(await first.export());
      expect(await spanComponentsToObjectId({ state, components })).toBe(
        projectId,
      );
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  test("shares concurrent and sequential lookups across loggers and imported parents", async () => {
    const { state, fetch } = createState();
    const logger = initLogger({
      state,
      projectName: "project",
      setCurrent: false,
    });
    const components = SpanComponentsV4.fromStr(await logger.export());
    const ids = await Promise.all([
      logger.id,
      ...Array.from(
        { length: 10 },
        () =>
          initLogger({ state, projectName: "project", setCurrent: false }).id,
      ),
      ...Array.from({ length: 10 }, () =>
        spanComponentsToObjectId({ state, components }),
      ),
    ]);
    expect(ids).toEqual(Array(21).fill(projectId));
    await initLogger({ state, projectName: "project", setCurrent: false }).id;
    expect(
      fetch.mock.calls.map(([url]) => new URL(String(url)).pathname),
    ).toEqual(["/api/apikey/login", "/api/project/register"]);
  });

  test("shares lookups from starting, updating, and resuming unresolved spans", async () => {
    const { state, fetch } = createState();
    state.httpLogger().syncFlush = true;
    const root = initLogger({
      state,
      projectName: "project",
      setCurrent: false,
    }).startSpan();
    const exported = await root.export();
    startSpan({ state, parent: exported }).end();
    updateSpan({ state, exported, output: "updated" });
    _internalResumeSpan({ state, exported }).end();
    root.end();
    await state.bgLogger().flush();
    expect(
      fetch.mock.calls.filter(([url]) =>
        String(url).endsWith("/api/project/register"),
      ),
    ).toHaveLength(1);
  });

  test("refreshes once at 15 minutes without sliding expiry or rebinding existing loggers", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
    const { state } = createState();
    await state.login({});
    const register = vi
      .spyOn(state.appConn(), "post_json")
      .mockResolvedValue({ project: { id: projectId, name: "project" } });
    const logger = initLogger({
      state,
      projectName: "project",
      setCurrent: false,
    });
    await logger.id;
    vi.setSystemTime(ttl - 1);
    await initLogger({ state, projectName: "project", setCurrent: false }).id;
    expect(register).toHaveBeenCalledTimes(1);
    vi.setSystemTime(ttl);
    register.mockResolvedValue({
      project: { id: "replacement-id", name: "project" },
    });
    expect(
      await Promise.all(
        Array.from(
          { length: 10 },
          () =>
            initLogger({ state, projectName: "project", setCurrent: false }).id,
        ),
      ),
    ).toEqual(Array(10).fill("replacement-id"));
    expect(register).toHaveBeenCalledTimes(2);
    expect(await logger.id).toBe(projectId);
    vi.setSystemTime(2 * ttl - 1);
    await initLogger({ state, projectName: "project", setCurrent: false }).id;
    expect(register).toHaveBeenCalledTimes(2);
  });

  test("starts TTL on success and shares pending requests", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(0);
    const { state } = createState();
    await state.login({});
    let resolve!: (value: unknown) => void;
    const register = vi.spyOn(state.appConn(), "post_json").mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const first = initLogger({
      state,
      projectName: "project",
      setCurrent: false,
    }).id;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(register).toHaveBeenCalledTimes(1);
    const second = initLogger({
      state,
      projectName: "project",
      setCurrent: false,
    }).id;
    resolve({ project: { id: projectId, name: "project" } });
    await Promise.all([first, second]);
    expect(vi.getTimerCount()).toBe(0);
    vi.setSystemTime(20_000 + ttl - 1);
    await initLogger({ state, projectName: "project", setCurrent: false }).id;
    expect(register).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["name", "headers"],
    ["name", "body"],
    ["id", "headers"],
    ["id", "body"],
  ])(
    "times out stalled %s lookup %s and allows retry",
    async (lookup, stage) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { state, fetch } = createState();
      await state.login({});
      let signal: AbortSignal | null | undefined;
      let completeFirst!: () => void;
      fetch.mockImplementationOnce((_, init) => {
        signal = init?.signal;
        const body = {
          name: "project",
          project: { id: "stale-id", name: "project" },
        };
        if (stage === "headers") {
          return new Promise((resolve) => {
            completeFirst = () => resolve(Response.json(body));
          });
        }
        const response = Response.json(body);
        vi.spyOn(response, "text").mockImplementation(
          () =>
            new Promise((resolve) => {
              completeFirst = () => resolve(JSON.stringify(body));
            }),
        );
        return Promise.resolve(response);
      });
      const options = {
        state,
        setCurrent: false,
        ...(lookup === "name" ? { projectName: "project" } : { projectId }),
      };
      const results = Promise.allSettled([
        initLogger(options).project,
        initLogger(options).project,
      ]);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      for (const result of await results) {
        expect(result).toMatchObject({
          status: "rejected",
          reason: new Error(
            "Braintrust project lookup timed out after 30 seconds.",
          ),
        });
      }
      expect(signal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);

      const replacement = await initLogger(options).project;
      expect(replacement.id).toBe(projectId);
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(vi.getTimerCount()).toBe(0);

      // A custom fetch can ignore cancellation and finish after the replacement.
      completeFirst();
      await vi.advanceTimersByTimeAsync(0);
      expect(await initLogger(options).project).toEqual(replacement);
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  test("shares failures but permits retries from later loggers", async () => {
    const { state } = createState();
    await state.login({});
    const register = vi
      .spyOn(state.appConn(), "post_json")
      .mockRejectedValueOnce(new Error("lookup failed"))
      .mockResolvedValue({ project: { id: projectId, name: "project" } });
    const results = await Promise.allSettled(
      Array.from(
        { length: 10 },
        () =>
          initLogger({ state, projectName: "project", setCurrent: false }).id,
      ),
    );
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(register).toHaveBeenCalledTimes(1);
    expect(
      await initLogger({ state, projectName: "project", setCurrent: false }).id,
    ).toBe(projectId);
    expect(register).toHaveBeenCalledTimes(2);
  });

  test("normalizes the default project and keeps name and ID lookups separate", async () => {
    const { state } = createState();
    await state.login({});
    const register = vi.spyOn(state.appConn(), "post_json");
    const get = vi.spyOn(state.appConn(), "get_json");
    await Promise.all([
      initLogger({ state, setCurrent: false }).id,
      initLogger({ state, projectName: "Global", setCurrent: false }).id,
      initLogger({ state, projectName: projectId, setCurrent: false }).id,
      initLogger({ state, projectId, setCurrent: false }).id,
      initLogger({ state, projectId, setCurrent: false }).id,
    ]);
    expect(register).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalledTimes(1);
    await initLogger({
      state,
      projectId,
      projectName: "explicit",
      setCurrent: false,
    }).id;
    expect(get).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledTimes(2);
  });

  test.each(["orgId", "loginToken", "appUrl"] as const)(
    "isolates changes to %s",
    async (field) => {
      const { state } = createState();
      await state.login({});
      const register = vi.spyOn(state.appConn(), "post_json");
      await initLogger({ state, projectName: "project", setCurrent: false }).id;
      state[field] = "changed";
      await initLogger({ state, projectName: "project", setCurrent: false }).id;
      expect(register).toHaveBeenCalledTimes(2);
    },
  );

  test.each(["reset", "forceLogin", "fetch"])(
    "invalidates on %s and does not reuse pending results",
    async (action) => {
      const { state, fetch } = createState();
      await state.login({});
      let resolve!: (value: unknown) => void;
      const register = vi
        .spyOn(state.appConn(), "post_json")
        .mockImplementationOnce(
          () =>
            new Promise((r) => {
              resolve = r;
            }),
        );
      const first = initLogger({
        state,
        projectName: "project",
        setCurrent: false,
      }).id;
      await vi.waitFor(() => expect(register).toHaveBeenCalledTimes(1));
      if (action === "reset") {
        state.resetLoginInfo();
      } else if (action === "forceLogin") {
        await state.login({ forceLogin: true });
      } else {
        state.setFetch((...args) => fetch(...args));
      }
      await initLogger({ state, projectName: "project", setCurrent: false }).id;
      resolve({ project: { id: "stale-id", name: "project" } });
      expect(await first).toBe("stale-id");
      expect(
        await initLogger({ state, projectName: "project", setCurrent: false })
          .id,
      ).toBe(projectId);
      expect(
        fetch.mock.calls.filter(([url]) =>
          String(url).endsWith("/api/project/register"),
        ),
      ).toHaveLength(1);
    },
  );

  test("isolates states and evicts the least recently used entry at 1,000 projects", async () => {
    const { state } = createState();
    await state.login({});
    const register = vi.spyOn(state.appConn(), "post_json");
    for (let index = 0; index < 1000; index++) {
      await initLogger({
        state,
        projectName: `project-${index}`,
        setCurrent: false,
      }).id;
    }
    await initLogger({ state, projectName: "project-0", setCurrent: false }).id;
    await initLogger({ state, projectName: "project-1000", setCurrent: false })
      .id;
    await initLogger({ state, projectName: "project-0", setCurrent: false }).id;
    expect(register).toHaveBeenCalledTimes(1001);
    await initLogger({ state, projectName: "project-1", setCurrent: false }).id;
    expect(register).toHaveBeenCalledTimes(1002);
    const other = createState();
    await initLogger({
      state: other.state,
      projectName: "project-0",
      setCurrent: false,
    }).id;
    expect(other.fetch).toHaveBeenCalledTimes(2);
  });
});

describe("login deduplication", () => {
  test.each(["headers", "body"])(
    "times out stalled %s, unblocks forced login, and ignores late results",
    async (stage) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { state, fetch } = createState();
      let signal: AbortSignal | null | undefined;
      let completeFirst!: () => void;
      fetch.mockImplementationOnce((_, init) => {
        signal = init?.signal;
        if (stage === "headers") {
          return new Promise((resolve) => {
            completeFirst = () => resolve(loginResponse("old-org"));
          });
        }
        const response = loginResponse("old-org");
        vi.spyOn(response, "text").mockImplementation(
          () =>
            new Promise((resolve) => {
              completeFirst = () =>
                resolve(
                  JSON.stringify({
                    org_info: [
                      {
                        id: "old-org",
                        name: "old-org",
                        api_url: "https://api.test",
                      },
                    ],
                  }),
                );
            }),
        );
        return Promise.resolve(response);
      });
      const first = state.login({});
      const duplicate = state.login({});
      const firstResults = Promise.allSettled([first, duplicate]);
      const replacementFetch = vi.fn<typeof globalThis.fetch>(async () =>
        loginResponse("new-org"),
      );
      const replacement = state.login({
        forceLogin: true,
        fetch: replacementFetch,
      });
      await vi.advanceTimersByTimeAsync(29_999);
      expect(replacementFetch).not.toHaveBeenCalled();
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      for (const result of await firstResults) {
        expect(result).toMatchObject({
          status: "rejected",
          reason: new Error("Braintrust login timed out after 30 seconds."),
        });
      }
      await replacement;
      expect(signal?.aborted).toBe(true);
      expect(replacementFetch).toHaveBeenCalledTimes(1);
      expect(state.orgId).toBe("new-org");
      completeFirst();
      await vi.advanceTimersByTimeAsync(0);
      expect(state.orgId).toBe("new-org");
      expect(state.fetch).toBe(replacementFetch);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  test("shares cold logins and keeps completed logins cached", async () => {
    const { state, fetch } = createState();
    await Promise.all(Array.from({ length: 10 }, () => state.login({})));
    await state.login({});
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(state.loggedIn).toBe(true);
  });

  test("shares errors and allows a later retry", async () => {
    const { state, fetch } = createState();
    fetch.mockRejectedValueOnce(new Error("login failed"));
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => state.login({})),
    );
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    await state.login({});
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(state.loggedIn).toBe(true);
  });

  test.each(["apiKey", "appUrl", "orgName", "fetch"] as const)(
    "does not combine differing %s options",
    async (field) => {
      const { state, fetch } = createState();
      await Promise.all([
        state.login({}),
        state.login(
          field === "fetch"
            ? { fetch: (...args) => fetch(...args) }
            : {
                [field]:
                  field === "orgName"
                    ? "org-id"
                    : field === "appUrl"
                      ? "https://other.test"
                      : "different",
              },
        ),
      ]);
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  test.each([false, true])(
    "concurrent forced loggers remain usable (credential discovery: %s)",
    async (discoverCredential) => {
      const { fetch } = createState();
      const state = new BraintrustState({
        apiKey: discoverCredential ? undefined : "test-credential",
        appUrl: "https://app.test",
        fetch,
        noExitFlush: true,
      });
      vi.spyOn(iso, "getBraintrustApiKey").mockResolvedValue("test-credential");
      state.httpLogger().syncFlush = true;
      const loggers = Array.from({ length: 2 }, () =>
        initLogger({
          state,
          projectName: "project",
          forceLogin: true,
          setCurrent: false,
        }),
      );
      expect(await Promise.all(loggers.map((logger) => logger.id))).toEqual([
        projectId,
        projectId,
      ]);
      for (const [index, logger] of loggers.entries()) {
        logger.startSpan({ name: `forced-${index}` }).end();
      }
      await state.bgLogger().flush();
      const rows = fetch.mock.calls
        .filter(([url]) => String(url).endsWith("/logs3"))
        .flatMap(([, init]) => JSON.parse(String(init?.body)).rows);
      expect(rows.map((row) => row.span_attributes.name).sort()).toEqual([
        "forced-0",
        "forced-1",
      ]);
      expect(
        fetch.mock.calls.filter(([url]) =>
          String(url).endsWith("/api/apikey/login"),
        ),
      ).toHaveLength(2);
    },
  );

  test.each([false, true])(
    "queues a forced login behind the earlier attempt (forceLogin: %s)",
    async (forceLogin) => {
      const { state, fetch } = createState();
      let resolveFirst!: (value: Response) => void;
      let resolveReplacement!: (value: Response) => void;
      fetch
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveFirst = resolve;
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveReplacement = resolve;
            }),
        );
      const first = state.login({ forceLogin });
      const replacement = state.login({ forceLogin: true });
      expect(fetch).toHaveBeenCalledTimes(1);
      resolveFirst(loginResponse("old-org"));
      await first;
      expect(state.orgId).toBe("old-org");
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      resolveReplacement(loginResponse("new-org"));
      await replacement;
      expect(state.orgId).toBe("new-org");
    },
  );

  test("a failed login does not prevent the queued forced login from succeeding", async () => {
    const { state, fetch } = createState();
    fetch.mockRejectedValueOnce(new Error("login failed"));
    const results = await Promise.allSettled([
      state.login({ forceLogin: true }),
      state.login({ forceLogin: true }),
    ]);
    expect(results.map((result) => result.status)).toEqual([
      "rejected",
      "fulfilled",
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(state.loggedIn).toBe(true);
  });

  test("reset cancels pending and queued logins without blocking a new login", async () => {
    const { state, fetch } = createState();
    let resolve!: (value: Response) => void;
    fetch.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const first = state.login({});
    const queued = state.login({ forceLogin: true });
    const results = Promise.allSettled([first, queued]);
    state.resetLoginInfo();
    fetch.mockResolvedValueOnce(loginResponse("new-org"));
    await state.login({});
    resolve(loginResponse("old-org"));
    for (const result of await results) {
      expect(result).toMatchObject({
        status: "rejected",
        reason: new Error("Login cancelled by a reset."),
      });
    }
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(state.orgId).toBe("new-org");
  });

  test.each([false, true])(
    "reset cancels credential discovery (forceLogin: %s)",
    async (forceLogin) => {
      const { fetch } = createState();
      const state = new BraintrustState({
        appUrl: "https://app.test",
        fetch,
        noExitFlush: true,
      });
      let resolveCredential!: (value: string) => void;
      vi.spyOn(iso, "getBraintrustApiKey").mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveCredential = resolve;
          }),
      );
      const first = state.login({ forceLogin });
      state.resetLoginInfo();
      resolveCredential("old-credential");
      await expect(first).rejects.toThrow("Login cancelled by a reset.");
      expect(state.loggedIn).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  test.each(["apiKey", "appUrl", "orgName", "fetch"] as const)(
    "rejects conflicting %s after credential discovery",
    async (field) => {
      const { fetch } = createState();
      const state = new BraintrustState({
        appUrl: "https://app.test",
        fetch,
        noExitFlush: true,
      });
      let resolveCredential!: (value: string) => void;
      vi.spyOn(iso, "getBraintrustApiKey").mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveCredential = resolve;
          }),
      );
      const first = state.login({});
      await state.login({
        apiKey: "test-credential",
        ...(field === "fetch"
          ? { fetch: (...args: Parameters<typeof fetch>) => fetch(...args) }
          : {
              [field]:
                field === "orgName"
                  ? "org-id"
                  : field === "appUrl"
                    ? "https://other.test"
                    : "different-credential",
            }),
      });
      resolveCredential("test-credential");
      await expect(first).rejects.toThrow(
        "Another login completed with different options",
      );
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(state.loginToken).toBe(
        field === "apiKey" ? "different-credential" : "test-credential",
      );
    },
  );

  test("does not log in again if another login completed during credential discovery", async () => {
    const { fetch } = createState();
    const state = new BraintrustState({
      appUrl: "https://app.test",
      fetch,
      noExitFlush: true,
    });
    let resolve!: (value: string) => void;
    vi.spyOn(iso, "getBraintrustApiKey").mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const first = state.login({});
    await state.login({ apiKey: "test-credential" });
    resolve("test-credential");
    await first;
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
