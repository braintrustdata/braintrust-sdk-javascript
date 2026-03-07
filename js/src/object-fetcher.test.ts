import { describe, expect, test, vi } from "vitest";
import {
  DEFAULT_FETCH_BATCH_SIZE,
  ObjectFetcher,
  type BraintrustState,
} from "./logger";
import { configureNode } from "./node/config";

configureNode();

type TestRecord = { id: string };

type MockBtqlResponse = {
  data: Array<Record<string, unknown>>;
  cursor?: string | null;
};

function createPostResponse(response: MockBtqlResponse) {
  return {
    json: vi.fn().mockResolvedValue(response),
  };
}

function createPostMock(
  response: MockBtqlResponse = { data: [], cursor: null },
) {
  return vi.fn().mockResolvedValue(createPostResponse(response));
}

class TestObjectFetcher extends ObjectFetcher<TestRecord> {
  constructor(
    private readonly postMock: ReturnType<typeof createPostMock>,
    internalBtql?: Record<string, unknown>,
  ) {
    super("dataset", undefined, undefined, internalBtql);
  }

  public get id(): Promise<string> {
    return Promise.resolve("test-dataset-id");
  }

  protected async getState(): Promise<BraintrustState> {
    return {
      apiConn: () => ({
        post: this.postMock,
      }),
    } as unknown as BraintrustState;
  }
}

async function triggerFetch(
  fetcher: TestObjectFetcher,
  options?: { batchSize?: number },
) {
  await fetcher.fetchedData(options);
}

function getBtqlQuery(
  postMock: ReturnType<typeof createPostMock>,
  callIndex = 0,
) {
  const call = postMock.mock.calls[callIndex];
  expect(call).toBeDefined();
  const requestBody = call[1] as { query: Record<string, unknown> };
  return requestBody.query;
}

describe("ObjectFetcher internal BTQL limit handling", () => {
  test("preserves custom _internal_btql limit instead of default batch size", async () => {
    const postMock = createPostMock();
    const fetcher = new TestObjectFetcher(postMock, {
      limit: 50,
      where: { op: "eq", left: "foo", right: "bar" },
    });

    await triggerFetch(fetcher);

    expect(postMock).toHaveBeenCalledTimes(1);
    const query = getBtqlQuery(postMock);
    expect(query.limit).toBe(50);
    expect(query.where).toEqual({ op: "eq", left: "foo", right: "bar" });
  });

  test("uses default batch size when no _internal_btql limit is provided", async () => {
    const postMock = createPostMock();
    const fetcher = new TestObjectFetcher(postMock);

    await triggerFetch(fetcher);

    const query = getBtqlQuery(postMock);
    expect(query.limit).toBe(DEFAULT_FETCH_BATCH_SIZE);
  });

  test("uses explicit fetch batchSize when no _internal_btql limit is provided", async () => {
    const postMock = createPostMock();
    const fetcher = new TestObjectFetcher(postMock);

    await triggerFetch(fetcher, { batchSize: 17 });

    const query = getBtqlQuery(postMock);
    expect(query.limit).toBe(17);
  });

  test("explicit batchSize overrides _internal_btql.limit", async () => {
    const postMock = createPostMock();
    const fetcher = new TestObjectFetcher(postMock, { limit: 100 });

    await triggerFetch(fetcher, { batchSize: 25 });

    const query = getBtqlQuery(postMock);
    expect(query.limit).toBe(25);
  });

  test("does not allow _internal_btql cursor to override pagination cursor", async () => {
    const postMock = vi
      .fn()
      .mockResolvedValueOnce(
        createPostResponse({
          data: [{ id: "record-1" }],
          cursor: "next-page-cursor",
        }),
      )
      .mockResolvedValueOnce(
        createPostResponse({
          data: [{ id: "record-2" }],
          cursor: null,
        }),
      );
    const fetcher = new TestObjectFetcher(postMock, {
      cursor: "stale-cursor",
      limit: 1,
    });

    await triggerFetch(fetcher);

    expect(postMock).toHaveBeenCalledTimes(2);
    const firstQuery = getBtqlQuery(postMock, 0);
    const secondQuery = getBtqlQuery(postMock, 1);
    expect(firstQuery.cursor).toBeUndefined();
    expect(secondQuery.cursor).toBe("next-page-cursor");
  });

  test("does not allow _internal_btql select/from to override base object query", async () => {
    const postMock = createPostMock();
    const fetcher = new TestObjectFetcher(postMock, {
      where: { op: "eq", left: "foo", right: "bar" },
      select: [{ op: "literal", value: "malicious-select" }],
      from: { op: "literal", value: "malicious-from" },
    });

    await triggerFetch(fetcher);

    const query = getBtqlQuery(postMock);
    expect(query.select).toEqual([{ op: "star" }]);
    expect(query.from).toEqual({
      op: "function",
      name: { op: "ident", name: ["dataset"] },
      args: [{ op: "literal", value: "test-dataset-id" }],
    });
    expect(query.where).toEqual({ op: "eq", left: "foo", right: "bar" });
  });
});
