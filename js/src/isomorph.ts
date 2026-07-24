import {
  type GitMetadataSettingsType as GitMetadataSettings,
  type RepoInfoType as RepoInfo,
} from "./generated_types";
import {
  newGlobalTracingChannel,
  type GlobalHookAsyncLocalStorage,
  type GlobalHookChannel,
  type GlobalHookHandlers,
  type GlobalTracingChannel,
  type GlobalTracingChannelCollection,
} from "./global-instrumentation-hooks";

export interface CallerLocation {
  caller_functionname: string;
  caller_filename: string;
  caller_lineno: number;
}

export type IsoAsyncLocalStorage<T> = GlobalHookAsyncLocalStorage<T>;
export type IsoChannel<
  M = any,
  N extends string | symbol = string,
> = GlobalHookChannel<M, N>;

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

export type IsoTracingChannelCollection<M = any> =
  GlobalTracingChannelCollection<M>;
export type IsoTracingChannel<M = any> = GlobalTracingChannel<M>;
export type IsoChannelHandlers<M = any> = GlobalHookHandlers<M>;

interface Common {
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
  getBraintrustApiKey: () => Promise<string | undefined>;
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

  // HMAC-SHA256 for authenticating opaque instrumentation state.
  hmacSha256?: (key: string, data: string) => string;
  timingSafeEqual?: (left: string, right: string) => boolean;

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
  getBraintrustApiKey: async () => undefined,
  getCallerLocation: () => undefined,
  newAsyncLocalStorage: <T>() => new DefaultAsyncLocalStorage<T>(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  newTracingChannel: <M = any>(
    nameOrChannels: string | IsoTracingChannelCollection<M>,
  ) => newGlobalTracingChannel<M>(nameOrChannels),
  processOn: (_0, _1) => {},
  basename: (filepath: string) => filepath.split(/[\\/]/).pop() || filepath,
  // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
  writeln: (text: string) => console.log(text),
};
export default iso;
