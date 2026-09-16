import { expect, test, vi } from "vitest";
import { BraintrustState } from "./logger";
import { configureNode } from "./node/config";
import { Queue } from "./queue";
import { LazyValue } from "./util";
import type { BackgroundLogEvent } from "../util";

configureNode();

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
  });
}

function createState(
  fetch: typeof globalThis.fetch,
  options: {
    onFlushError?: (error: unknown) => void;
  } = {},
) {
  const state = new BraintrustState({
    fetch,
    noExitFlush: true,
    ...options,
  });
  state.apiUrl = "https://api.test";
  state.orgId = "org-id";
  return state;
}

function enqueueEvents(state: BraintrustState, start: number, count: number) {
  state.httpLogger().log(
    Array.from(
      { length: count },
      (_, index) =>
        new LazyValue<BackgroundLogEvent>(async () => ({
          id: `event-${start + index}`,
          dataset_id: "dataset-id",
        })),
    ),
  );
}

test("flush only waits for events enqueued before it was called", async () => {
  const logRequests: Array<ReturnType<typeof deferred<Response>>> = [];
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    if (String(input).endsWith("/version")) {
      return Promise.resolve(
        jsonResponse({ logs3_payload_max_bytes: 6 * 1024 * 1024 }),
      );
    }

    const request = deferred<Response>();
    logRequests.push(request);
    return request.promise;
  });
  const state = createState(fetchMock as unknown as typeof globalThis.fetch);
  const logger = state.httpLogger();
  logger.syncFlush = true;

  enqueueEvents(state, 0, 100);
  const firstFlush = logger.flush();
  let firstFlushResolved = false;
  void firstFlush.then(() => {
    firstFlushResolved = true;
  });

  await vi.waitFor(() => expect(logRequests).toHaveLength(1));

  enqueueEvents(state, 100, 100);
  const secondFlush = logger.flush();
  let secondFlushResolved = false;
  void secondFlush.then(() => {
    secondFlushResolved = true;
  });

  logRequests[0].resolve(jsonResponse({}));
  await firstFlush;
  expect(firstFlushResolved).toBe(true);
  expect(secondFlushResolved).toBe(false);

  await vi.waitFor(() => expect(logRequests).toHaveLength(2));
  logRequests[1].resolve(jsonResponse({}));
  await secondFlush;
  expect(secondFlushResolved).toBe(true);
});

test("failed events are discarded without stranding later events", async () => {
  const onFlushError = vi.fn(() => {
    throw new Error("callback failure");
  });
  const logRequests: Array<ReturnType<typeof deferred<Response>>> = [];
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    if (String(input).endsWith("/version")) {
      return Promise.resolve(
        jsonResponse({ logs3_payload_max_bytes: 6 * 1024 * 1024 }),
      );
    }

    const request = deferred<Response>();
    logRequests.push(request);
    return request.promise;
  });
  const state = createState(fetchMock as unknown as typeof globalThis.fetch, {
    onFlushError,
  });
  const logger = state.httpLogger();
  logger.syncFlush = true;
  logger.numTries = 1;

  enqueueEvents(state, 0, 1);
  const firstFlush = logger.flush();
  await vi.waitFor(() => expect(logRequests).toHaveLength(1));

  enqueueEvents(state, 1, 1);
  const secondFlush = logger.flush();

  logRequests[0].resolve(
    new Response("failed", {
      status: 500,
      statusText: "Internal Server Error",
    }),
  );
  await expect(firstFlush).resolves.toBeUndefined();
  await vi.waitFor(() => expect(logRequests).toHaveLength(2));

  logRequests[1].resolve(jsonResponse({}));
  await expect(secondFlush).resolves.toBeUndefined();
  expect(onFlushError).toHaveBeenCalledOnce();

  await expect(logger.flush()).resolves.toBeUndefined();
  expect(logRequests).toHaveLength(2);
});

test("events enqueued as an active flush stops are not stranded", async () => {
  let logRequestCount = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/version")) {
      return jsonResponse({ logs3_payload_max_bytes: 6 * 1024 * 1024 });
    }

    logRequestCount++;
    return jsonResponse({});
  });
  const state = createState(fetchMock as unknown as typeof globalThis.fetch);
  const logger = state.httpLogger();
  const queue = Reflect.get(logger, "queue") as Queue<{
    sequence: number;
    event: LazyValue<BackgroundLogEvent>;
  }>;
  const originalDrainWhile = queue.drainWhile.bind(queue);
  let enqueuedFollowup = false;
  vi.spyOn(queue, "drainWhile").mockImplementation((predicate) => {
    const items = originalDrainWhile(predicate);
    if (items.length > 0 && !enqueuedFollowup) {
      enqueuedFollowup = true;
      enqueueEvents(state, 1, 1);
    }
    return items;
  });

  enqueueEvents(state, 0, 1);
  await vi.waitFor(() => expect(logRequestCount).toBe(2));
  await logger.flush();
});

test("log request concurrency is limited to eight by default", async () => {
  let activeRequests = 0;
  let peakActiveRequests = 0;
  let logRequestCount = 0;
  const gate = deferred<void>();
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/version")) {
      return jsonResponse({ logs3_payload_max_bytes: 6 * 1024 * 1024 });
    }

    logRequestCount++;
    activeRequests++;
    peakActiveRequests = Math.max(peakActiveRequests, activeRequests);
    await gate.promise;
    activeRequests--;
    return jsonResponse({});
  });
  const state = createState(fetchMock as unknown as typeof globalThis.fetch);
  const logger = state.httpLogger();
  logger.syncFlush = true;
  logger.defaultBatchSize = 1;

  enqueueEvents(state, 0, 24);
  const flush = logger.flush();

  await vi.waitFor(() => expect(logRequestCount).toBe(8));
  expect(peakActiveRequests).toBe(8);

  gate.resolve();
  await flush;
  expect(logRequestCount).toBe(24);
  expect(peakActiveRequests).toBe(8);
});
