/// <reference lib="dom" />
import { TRANSACTION_ID_FIELD, TransactionId } from "../util";
import { BraintrustState, BTQL_HTTP_RETRIES } from "./core";

export type WithTransactionId<R> = R & {
  [TRANSACTION_ID_FIELD]: TransactionId;
};

export const DEFAULT_FETCH_BATCH_SIZE = 1000;

const MAX_BTQL_ITERATIONS = 10000;

export class ObjectFetcher<RecordType> implements AsyncIterable<
  WithTransactionId<RecordType>
> {
  private _fetchedData: WithTransactionId<RecordType>[] | undefined = undefined;

  constructor(
    private objectType:
      | "dataset"
      | "experiment"
      | "project_logs"
      | "playground_logs",
    private pinnedVersion: string | undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private mutateRecord?: (r: any) => WithTransactionId<RecordType>,
    private _internal_btql?: Record<string, unknown>,
    private _internalBrainstoreRealtime = true,
  ) {}

  public get id(): Promise<string> {
    throw new Error("ObjectFetcher subclasses must have an 'id' attribute");
  }

  protected async getState(): Promise<BraintrustState> {
    throw new Error("ObjectFetcher subclasses must have a 'getState' method");
  }

  protected getPinnedVersion(): string | undefined {
    return this.pinnedVersion;
  }

  protected setPinnedVersion(pinnedVersion: string | undefined): void {
    this.pinnedVersion = pinnedVersion;
  }

  protected getInternalBtql(): Record<string, unknown> | undefined {
    return this._internal_btql;
  }

  private async *fetchRecordsFromApi(
    batchSize: number | undefined,
  ): AsyncGenerator<WithTransactionId<RecordType>> {
    const state = await this.getState();
    const objectId = await this.id;
    const batchLimit = batchSize ?? DEFAULT_FETCH_BATCH_SIZE;
    const internalLimit = getInternalBtqlLimit(this._internal_btql);
    let remainingLimit = internalLimit;
    const internalBtqlWithoutReservedQueryKeys = Object.fromEntries(
      Object.entries(this._internal_btql ?? {}).filter(
        ([key]) =>
          key !== "cursor" &&
          key !== "limit" &&
          key !== "select" &&
          key !== "from",
      ),
    );
    let cursor = undefined;
    let iterations = 0;
    while (true) {
      if (remainingLimit !== undefined && remainingLimit <= 0) {
        return;
      }
      const limit =
        remainingLimit === undefined
          ? batchLimit
          : Math.min(batchLimit, remainingLimit);
      const resp = await state.apiConn().post(
        `btql`,
        {
          query: {
            select: [
              {
                op: "star",
              },
            ],
            from: {
              op: "function",
              name: {
                op: "ident",
                name: [this.objectType],
              },
              args: [
                {
                  op: "literal",
                  value: objectId,
                },
              ],
            },
            cursor,
            limit,
            ...internalBtqlWithoutReservedQueryKeys,
          },
          use_columnstore: false,
          brainstore_realtime: this._internalBrainstoreRealtime,
          query_source: `js_sdk_object_fetcher_${this.objectType}`,
          ...(this.pinnedVersion !== undefined
            ? {
                version: this.pinnedVersion,
              }
            : {}),
        },
        { headers: { "Accept-Encoding": "gzip" } },
        BTQL_HTTP_RETRIES,
      );
      const respJson = await resp.json();
      const mutate = this.mutateRecord;
      for (const record of respJson.data ?? []) {
        if (remainingLimit !== undefined && remainingLimit <= 0) {
          return;
        }
        const mutatedRecord = mutate
          ? mutate(record)
          : (record as WithTransactionId<RecordType>);
        if (remainingLimit !== undefined) {
          remainingLimit--;
        }
        yield mutatedRecord;
      }
      if (!respJson.cursor) {
        break;
      }
      cursor = respJson.cursor;
      iterations++;
      if (iterations > MAX_BTQL_ITERATIONS) {
        throw new Error("Too many BTQL iterations");
      }
    }
  }

  /**
   * Fetch all records from the object.
   *
   * @param options Optional parameters for fetching.
   * @param options.batchSize The number of records to fetch per request. Defaults to 1000.
   * @returns An async generator of records.
   */
  async *fetch(options?: {
    batchSize?: number;
  }): AsyncGenerator<WithTransactionId<RecordType>> {
    if (this._fetchedData !== undefined) {
      for (const record of this._fetchedData) {
        yield record;
      }
      return;
    }

    for await (const record of this.fetchRecordsFromApi(options?.batchSize)) {
      yield record;
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<WithTransactionId<RecordType>> {
    return this.fetch();
  }

  async fetchedData(options?: {
    batchSize?: number;
  }): Promise<WithTransactionId<RecordType>[]> {
    if (this._fetchedData === undefined) {
      const data: WithTransactionId<RecordType>[] = [];
      for await (const record of this.fetchRecordsFromApi(options?.batchSize)) {
        data.push(record);
      }
      this._fetchedData = data;
    }
    return this._fetchedData || [];
  }

  clearCache(): void {
    this._fetchedData = undefined;
  }

  public async version(options?: {
    batchSize?: number;
  }): Promise<string | undefined> {
    if (this.pinnedVersion !== undefined) {
      return this.pinnedVersion;
    } else {
      let maxVersion: string | undefined = undefined;
      for await (const record of this.fetch(options)) {
        const xactId = String(record[TRANSACTION_ID_FIELD] ?? "0");
        if (maxVersion === undefined || xactId > maxVersion) {
          maxVersion = xactId;
        }
      }
      return maxVersion;
    }
  }
}

function getInternalBtqlLimit(
  internalBtql?: Record<string, unknown>,
): number | undefined {
  const limit = internalBtql?.["limit"];
  return typeof limit === "number" ? limit : undefined;
}
