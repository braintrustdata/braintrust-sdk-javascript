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

  test("starts TTL on success and shares requests even when resolution takes over 15 minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
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
    await vi.waitFor(() => expect(register).toHaveBeenCalledTimes(1));
    vi.setSystemTime(ttl * 2);
    const second = initLogger({
      state,
      projectName: "project",
      setCurrent: false,
    }).id;
    resolve({ project: { id: projectId, name: "project" } });
    await Promise.all([first, second]);
    vi.setSystemTime(ttl * 3 - 1);
    await initLogger({ state, projectName: "project", setCurrent: false }).id;
    expect(register).toHaveBeenCalledTimes(1);
  });

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

  test("forceLogin always starts a fresh request", async () => {
    const { state, fetch } = createState();
    await state.login({});
    const results = await Promise.allSettled([
      state.login({ forceLogin: true }),
      state.login({ forceLogin: true }),
    ]);
    expect(results.map((result) => result.status)).toEqual([
      "rejected",
      "fulfilled",
    ]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  test("forced logins remain independent during asynchronous credential discovery", async () => {
    const { fetch } = createState();
    const state = new BraintrustState({
      appUrl: "https://app.test",
      fetch,
      noExitFlush: true,
    });
    vi.spyOn(iso, "getBraintrustApiKey").mockResolvedValue("test-credential");
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

  test.each(["reset", "forceLogin"])(
    "an older pending login cannot overwrite %s",
    async (action) => {
      const { state, fetch } = createState();
      let resolve!: (value: Response) => void;
      fetch.mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      );
      const first = state.login({});
      expect(fetch).toHaveBeenCalledTimes(1);
      if (action === "reset") {
        state.resetLoginInfo();
      } else {
        fetch.mockResolvedValueOnce(loginResponse("new-org"));
        await state.login({ forceLogin: true });
      }
      resolve(loginResponse("old-org"));
      await expect(first).rejects.toThrow(
        "Login cancelled by a reset or a newer forced login.",
      );
      expect(state.orgId).toBe(action === "reset" ? null : "new-org");
    },
  );

  test.each([false, true])(
    "cancels an earlier login before its forced replacement completes (forceLogin: %s)",
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
      resolveFirst(loginResponse("old-org"));
      await expect(first).rejects.toThrow(
        "Login cancelled by a reset or a newer forced login.",
      );
      expect(state.loggedIn).toBe(false);
      resolveReplacement(loginResponse("new-org"));
      await replacement;
      expect(state.orgId).toBe("new-org");
      expect(state.loggedIn).toBe(true);
    },
  );

  test.each(["reset", "forceLogin"])(
    "cancels credential discovery superseded by %s",
    async (action) => {
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
      let resolveReplacement!: (value: Response) => void;
      fetch.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveReplacement = resolve;
          }),
      );
      const first = state.login({});
      let replacement: Promise<void> | undefined;
      if (action === "reset") {
        state.resetLoginInfo();
      } else {
        replacement = state.login({
          apiKey: "replacement-credential",
          forceLogin: true,
        });
      }
      resolveCredential("old-credential");
      await expect(first).rejects.toThrow(
        "Login cancelled by a reset or a newer forced login.",
      );
      expect(state.loggedIn).toBe(false);
      expect(fetch).toHaveBeenCalledTimes(action === "reset" ? 0 : 1);
      if (replacement) {
        resolveReplacement(loginResponse("new-org"));
        await replacement;
        expect(state.orgId).toBe("new-org");
        expect(state.loggedIn).toBe(true);
      }
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
