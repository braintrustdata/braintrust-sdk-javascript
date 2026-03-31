import {
  type GitMetadataSettingsType as GitMetadataSettings,
  type RepoInfoType as RepoInfo,
} from "./generated_types";

export interface CallerLocation {
  caller_functionname: string;
  caller_filename: string;
  caller_lineno: number;
}

export interface IsoAsyncLocalStorage<T> {
  enterWith(store: T): void;
  run<R>(store: T | undefined, callback: () => R): R;
  getStore(): T | undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type IsoMessageFunction<M = any, N extends string | symbol = string> = (
  message: M,
  name: N,
) => void;

export type IsoTransformFunction<M, S> = (message: M) => S;

/**
 * Channel interface matching the shared node:diagnostics_channel and dc-browser API.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface IsoChannel<M = any, N extends string | symbol = string> {
  readonly name: N;
  readonly hasSubscribers: boolean;
  subscribe(subscription: IsoMessageFunction<M, N>): void;
  unsubscribe(subscription: IsoMessageFunction<M, N>): boolean;
  bindStore<T>(
    store: IsoAsyncLocalStorage<T>,
    transform?: IsoTransformFunction<M, T>,
  ): void;
  unbindStore<T>(store: IsoAsyncLocalStorage<T>): boolean;
  publish(message: M): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  runStores<F extends (...args: any[]) => any>(
    message: M,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: Parameters<F>
  ): ReturnType<F>;
}

class DefaultAsyncLocalStorage<T> implements IsoAsyncLocalStorage<T> {
  constructor() {}

  enterWith(_: T): void {}
  run<R>(_: T | undefined, callback: () => R): R {
    return callback();
  }
  getStore(): T | undefined {
    return undefined;
  }
}

class DefaultChannel<
  M,
  N extends string | symbol = string,
> implements IsoChannel<M, N> {
  readonly hasSubscribers = false;

  constructor(public readonly name: N) {}

  subscribe(_subscription: IsoMessageFunction<M, N>): void {}

  unsubscribe(_subscription: IsoMessageFunction<M, N>): boolean {
    return false;
  }

  bindStore<T>(
    _store: IsoAsyncLocalStorage<T>,
    _transform?: IsoTransformFunction<M, T>,
  ): void {}

  unbindStore<T>(_store: IsoAsyncLocalStorage<T>): boolean {
    return false;
  }

  publish(_message: M): void {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  runStores<F extends (...args: any[]) => any>(
    _message: M,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: Parameters<F>
  ): ReturnType<F> {
    return fn.apply(thisArg, args);
  }
}

/**
 * TracingChannel interface matching both node:diagnostics_channel and dc-browser.
 * A composite of the five tracing subchannels used to instrument sync/async operations.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface IsoTracingChannelCollection<M = any> {
  readonly start?: IsoChannel<M>;
  readonly end?: IsoChannel<M>;
  readonly asyncStart?: IsoChannel<M>;
  readonly asyncEnd?: IsoChannel<M>;
  readonly error?: IsoChannel<M>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface IsoTracingChannel<
  M = any,
> extends IsoTracingChannelCollection<M> {
  readonly hasSubscribers: boolean;
  subscribe(handlers: IsoChannelHandlers<M>): void;
  unsubscribe(handlers: IsoChannelHandlers<M>): boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  traceSync<F extends (...args: any[]) => any>(
    fn: F,
    message?: M,
    thisArg?: ThisParameterType<F>,
    ...args: Parameters<F>
  ): ReturnType<F>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tracePromise<F extends (...args: any[]) => PromiseLike<any>>(
    fn: F,
    message?: M,
    thisArg?: ThisParameterType<F>,
    ...args: Parameters<F>
  ): ReturnType<F>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  traceCallback<F extends (...args: any[]) => any>(
    fn: F,
    position?: number,
    message?: M,
    thisArg?: ThisParameterType<F>,
    ...args: Parameters<F>
  ): ReturnType<F>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface IsoChannelHandlers<M = any> {
  start?: (context: M, name: string) => void;
  end?: (context: M, name: string) => void;
  asyncStart?: (context: M, name: string) => void;
  asyncEnd?: (context: M, name: string) => void;
  error?: (context: M, name: string) => void;
}

/**
 * Default no-op TracingChannel implementation.
 */
class DefaultTracingChannel<M> implements IsoTracingChannel<M> {
  readonly start: IsoChannel<M>;
  readonly end: IsoChannel<M>;
  readonly asyncStart: IsoChannel<M>;
  readonly asyncEnd: IsoChannel<M>;
  readonly error: IsoChannel<M>;

  constructor(nameOrChannels: string | IsoTracingChannelCollection<M>) {
    if (typeof nameOrChannels === "string") {
      this.start = new DefaultChannel(`tracing:${nameOrChannels}:start`);
      this.end = new DefaultChannel(`tracing:${nameOrChannels}:end`);
      this.asyncStart = new DefaultChannel(
        `tracing:${nameOrChannels}:asyncStart`,
      );
      this.asyncEnd = new DefaultChannel(`tracing:${nameOrChannels}:asyncEnd`);
      this.error = new DefaultChannel(`tracing:${nameOrChannels}:error`);
      return;
    }

    this.start = nameOrChannels.start ?? new DefaultChannel("tracing:start");
    this.end = nameOrChannels.end ?? new DefaultChannel("tracing:end");
    this.asyncStart =
      nameOrChannels.asyncStart ?? new DefaultChannel("tracing:asyncStart");
    this.asyncEnd =
      nameOrChannels.asyncEnd ?? new DefaultChannel("tracing:asyncEnd");
    this.error = nameOrChannels.error ?? new DefaultChannel("tracing:error");
  }

  get hasSubscribers(): boolean {
    return (
      this.start.hasSubscribers ||
      this.end.hasSubscribers ||
      this.asyncStart.hasSubscribers ||
      this.asyncEnd.hasSubscribers ||
      this.error.hasSubscribers
    );
  }

  subscribe(_handlers: IsoChannelHandlers<M>): void {}
  unsubscribe(_handlers: IsoChannelHandlers<M>): boolean {
    return false;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  traceSync<F extends (...args: any[]) => any>(
    fn: F,
    _message?: M,
    thisArg?: ThisParameterType<F>,
    ...args: Parameters<F>
  ): ReturnType<F> {
    return fn.apply(thisArg, args);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tracePromise<F extends (...args: any[]) => PromiseLike<any>>(
    fn: F,
    _message?: M,
    thisArg?: ThisParameterType<F>,
    ...args: Parameters<F>
  ): ReturnType<F> {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any
    return fn.apply(thisArg, args) as any;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  traceCallback<F extends (...args: any[]) => any>(
    fn: F,
    _position?: number,
    _message?: M,
    thisArg?: ThisParameterType<F>,
    ...args: Parameters<F>
  ): ReturnType<F> {
    return fn.apply(thisArg, args);
  }
}

export interface Common {
  buildType:
    | "browser" // deprecated, use /workerd or /edge-light entrypoints for edge environments
    | "browser-js" // @braintrust/browser package
    | "node"
    | "edge-light"
    | "workerd"
    | "unknown";

  getRepoInfo: (
    settings?: GitMetadataSettings,
  ) => Promise<RepoInfo | undefined>;
  getPastNAncestors: (n?: number, remote?: string) => Promise<string[]>;
  getEnv: (name: string) => string | undefined;
  getCallerLocation: () => CallerLocation | undefined;
  newAsyncLocalStorage: <T>() => IsoAsyncLocalStorage<T>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  newTracingChannel: <M = any>(
    nameOrChannels: string | IsoTracingChannelCollection<M>,
  ) => IsoTracingChannel<M>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  processOn: (event: string, handler: (code: any) => void) => void;

  // hash a string. not guaranteed to be crypto safe.
  hash?: (data: string) => string;

  // Cross-platform utilities.
  basename: (filepath: string) => string;
  writeln: (text: string) => void;

  // Filesystem operations (async).
  pathJoin?: (...args: string[]) => string;
  pathDirname?: (path: string) => string;
  mkdir?: (
    path: string,
    opts?: { recursive?: boolean },
  ) => Promise<string | undefined>;
  writeFile?: (filename: string, data: string) => Promise<void>;
  readFile?: (filename: string) => Promise<Uint8Array>;
  readdir?: (path: string) => Promise<string[]>;
  utimes?: (path: string, atime: Date, mtime: Date) => Promise<void>;
  unlink?: (path: string) => Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stat?: (path: string) => Promise<any>; // type-erased
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  statSync?: (path: string) => any; // type-erased
  homedir?: () => string;
  tmpdir?: () => string;

  // Filesystem operations (sync) - for span cache.
  writeFileSync?: (filename: string, data: string) => void;
  appendFileSync?: (filename: string, data: string) => void;
  readFileSync?: (filename: string, encoding: string) => string;
  unlinkSync?: (path: string) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  openFile?: (path: string, flags: string) => Promise<any>; // fs.promises.FileHandle, type-erased

  // zlib (promisified and type-erased).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  gunzip?: (data: any) => Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  gzip?: (data: any) => Promise<any>;
}

const iso: Common = {
  buildType: "unknown", // Will be set by configureBrowser() or configureNode()
  getRepoInfo: async (_settings) => undefined,
  getPastNAncestors: async () => [],
  getEnv: (_name) => undefined,
  getCallerLocation: () => undefined,
  newAsyncLocalStorage: <T>() => new DefaultAsyncLocalStorage<T>(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  newTracingChannel: <M = any>(
    nameOrChannels: string | IsoTracingChannelCollection<M>,
  ) => new DefaultTracingChannel<M>(nameOrChannels),
  processOn: (_0, _1) => {},
  basename: (filepath: string) => filepath.split(/[\\/]/).pop() || filepath,
  // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
  writeln: (text: string) => console.log(text),
};
export default iso;
