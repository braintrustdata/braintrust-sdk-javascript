export * from "../util";

export const GLOBAL_PROJECT = "Global";

// Given a function to execute, a catch handler, and a finally handler, runs the function and
// executes the catch handler if an error occurs. If the function returns a Promise, the finally handler
// is chained to the promise. Otherwise, it is run afterwards synchronously.
export function runCatchFinally<R>(
  f: () => R,
  catchF: (e: unknown) => R,
  finallyF: () => void,
): R {
  let runSyncCleanup = true;
  try {
    const ret = f();
    if (ret instanceof Promise) {
      runSyncCleanup = false;
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any
      return (ret as any).catch(catchF).finally(finallyF) as R;
    } else {
      return ret;
    }
  } catch (e) {
    return catchF(e);
  } finally {
    if (runSyncCleanup) {
      finallyF();
    }
  }
}

export function getCurrentUnixTimestamp(): number {
  return new Date().getTime() / 1000;
}

export function isEmpty(a: unknown): a is null | undefined {
  return a === undefined || a === null;
}

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === null || Object.getPrototypeOf(prototype) === null;
  } catch {
    return false;
  }
}

// A simple wrapper around a callable async function which computes the value
// on-demand and saves it for future retrievals. The difference between this and
// a bare Promise is that the async callable is run only when asked for. There
// should be no un-awaited promises floating around (as long as the user
// immediately consumes what is returned by `LazyValue.value()`).
export class LazyValue<T> {
  private callable: () => Promise<T>;
  private resolvedValue: T | undefined = undefined;
  private value:
    | { computedState: "succeeded"; val: Promise<T> }
    | { computedState: "in_progress"; val: Promise<T> }
    | { computedState: "uninitialized" } = {
    computedState: "uninitialized",
  };

  constructor(callable: () => Promise<T>) {
    this.callable = callable;
  }

  get(): Promise<T> {
    if (this.value.computedState !== "uninitialized") {
      return this.value.val;
    }
    // Note that we do not want to await the Promise returned by the callable
    // inside `get` before updating `computedState`, because that would allow
    // multiple async tasks to invoke `.get` concurrently and potentially invoke
    // `this.callable` multiple times. By keeping this method fully synchronous,
    // we guarantee that `callable` is only invoked once.
    //
    // Once the callable completes successfully, we update the computedState to
    // "succeeded".
    this.value = {
      computedState: "in_progress",
      val: this.callable().then((x) => {
        this.value.computedState = "succeeded";
        this.resolvedValue = x; // Store the resolved value
        return x;
      }),
    };
    return this.value.val;
  }

  getSync(): { resolved: boolean; value: T | undefined } {
    return {
      resolved: this.value.computedState === "succeeded",
      value: this.resolvedValue,
    };
  }

  // If this is true, the caller should be able to obtain the LazyValue without
  // it throwing.
  public get hasSucceeded(): boolean {
    return this.value.computedState === "succeeded";
  }
}

// Synchronous version of LazyValue.
export class SyncLazyValue<T> {
  private callable: () => T;
  private value:
    | { computedState: "succeeded"; val: T }
    | { computedState: "uninitialized" } = {
    computedState: "uninitialized",
  };

  constructor(callable: () => T) {
    this.callable = callable;
  }

  get(): T {
    if (this.value.computedState !== "uninitialized") {
      return this.value.val;
    }
    const result = this.callable();
    this.value = { computedState: "succeeded", val: result };
    return result;
  }

  // If this is true, the caller should be able to obtain the SyncLazyValue without
  // it throwing.
  public get hasSucceeded(): boolean {
    return this.value.computedState === "succeeded";
  }
}

export function addAzureBlobHeaders(
  headers: Record<string, string>,
  url: string,
) {
  // According to https://stackoverflow.com/questions/37824136/put-on-sas-blob-url-without-specifying-x-ms-blob-type-header,
  // there is no way to avoid including this.
  if (url.includes("blob.core.windows.net")) {
    headers["x-ms-blob-type"] = "BlockBlob";
  }
}

// Internal error class for indicating that an operation was aborted.
export class InternalAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InternalAbortError";
  }
}

// Return a copy of record with the given keys removed.
export function filterFrom(record: Record<string, any>, keys: string[]) {
  const out: Record<string, any> = {};
  for (const k of Object.keys(record)) {
    if (!keys.includes(k)) {
      out[k] = record[k];
    }
  }
  return out;
}
