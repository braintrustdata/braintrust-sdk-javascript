import { afterEach, describe, expect, it, vi } from "vitest";

const { tracePromise } = vi.hoisted(() => ({
  tracePromise: vi.fn((fn: () => Promise<unknown>, _event?: unknown) => fn()),
}));

vi.mock("../isomorph", () => ({
  default: {
    newTracingChannel: vi.fn(() => ({
      subscribe: vi.fn(),
      tracePromise,
      unsubscribe: vi.fn(),
    })),
  },
}));

import {
  wrapLangSmithClient,
  wrapLangSmithRunTrees,
  wrapLangSmithTraceable,
} from "./langsmith";

describe("LangSmith namespace wrappers", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("composes traceable on_end and preserves unrelated exports", async () => {
    const existingOnEnd = vi.fn();
    const run = {
      id: "run-1",
      name: "traceable run",
      run_type: "chain",
      inputs: { input: "hello" },
      outputs: { output: "world" },
      start_time: 1,
      end_time: 2,
      trace_id: "run-1",
    };
    const traceable = vi.fn(
      (
        fn: (value: string) => Promise<string>,
        config?: Record<string, unknown>,
      ) =>
        async (value: string) => {
          const result = await fn(value);
          (config?.on_end as ((run: unknown) => void) | undefined)?.(run);
          return result;
        },
    );
    const helper = () => "helper";
    const namespace = { helper, traceable };

    const wrapped = wrapLangSmithTraceable(namespace);
    const traced = wrapped.traceable(async (value: string) => `${value}!`, {
      on_end: existingOnEnd,
    });

    await expect(traced("hello")).resolves.toBe("hello!");
    expect(existingOnEnd).toHaveBeenCalledWith(run);
    expect(wrapped.helper).toBe(helper);
    expect(tracePromise).toHaveBeenCalledTimes(1);
    expect(tracePromise.mock.calls[0]?.[1]).toMatchObject({
      arguments: ["run-1", run],
    });
  });

  it("recursively wraps RunTree children without changing class identity", async () => {
    class RunTree {
      #secret = "run-tree-secret";

      id = "run-tree";
      name = "run tree";
      run_type = "chain";
      inputs = {};
      start_time = 1;
      trace_id = this.id;

      constructor(_config?: unknown) {}

      createChild(_config?: unknown) {
        return new RunTree();
      }

      postRun() {
        return Promise.resolve(this.#secret);
      }

      patchRun() {
        return Promise.resolve(this.#secret);
      }

      readSecret() {
        return this.#secret;
      }
    }

    const wrapped = wrapLangSmithRunTrees({ RunTree, untouched: true });
    const tree = new wrapped.RunTree({ name: "ignored" });
    const child = tree.createChild({ name: "child" });

    expect(tree).toBeInstanceOf(RunTree);
    expect(child).toBeInstanceOf(RunTree);
    expect(tree.readSecret()).toBe("run-tree-secret");
    await expect(tree.postRun()).resolves.toBe("run-tree-secret");
    await expect(child.patchRun()).resolves.toBe("run-tree-secret");
    expect(tracePromise).toHaveBeenCalledTimes(2);
  });

  it("wraps Client lifecycle methods and safely binds other methods", async () => {
    class Client {
      #secret = "client-secret";

      createRun(run: unknown) {
        return Promise.resolve(run);
      }

      updateRun(id: string, run: unknown) {
        return Promise.resolve({ id, run });
      }

      batchIngestRuns(runs: unknown) {
        return Promise.resolve(runs);
      }

      readSecret() {
        return this.#secret;
      }
    }

    const wrapped = wrapLangSmithClient({ Client });
    const client = new wrapped.Client();

    expect(client).toBeInstanceOf(Client);
    expect(client.readSecret()).toBe("client-secret");
    await client.createRun({ id: "create" });
    await client.updateRun("update", { output: true });
    await client.batchIngestRuns({ runCreates: [], runUpdates: [] });
    expect(tracePromise).toHaveBeenCalledTimes(3);
  });

  it("preserves Client method errors", async () => {
    const expected = new Error("client failure");
    class Client {
      async createRun(_run: unknown): Promise<never> {
        throw expected;
      }
    }

    const wrapped = wrapLangSmithClient({ Client });
    await expect(new wrapped.Client().createRun({})).rejects.toBe(expected);
  });

  it("does not double-wrap namespaces", async () => {
    class Client {
      createRun(_run: unknown) {
        return Promise.resolve();
      }
    }

    const wrapped = wrapLangSmithClient(wrapLangSmithClient({ Client }));
    await new wrapped.Client().createRun({ id: "one" });
    expect(tracePromise).toHaveBeenCalledTimes(1);
  });

  it("preserves namespace keys for module-shaped objects", () => {
    const namespace = Object.freeze({
      Client: class Client {},
      helper: "preserved",
    });

    const wrapped = wrapLangSmithClient(namespace);
    expect(Object.keys(wrapped)).toEqual(["Client", "helper"]);
    expect("helper" in wrapped).toBe(true);
    expect(wrapped.helper).toBe("preserved");
  });
});
