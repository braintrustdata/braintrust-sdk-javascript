import type { MessagePort } from "node:worker_threads";

export type LoaderAttributes = Readonly<Record<string, string | undefined>>;
export type LoaderContext = {
  conditions?: readonly string[];
  format?: string;
  importAssertions?: LoaderAttributes;
  importAttributes?: LoaderAttributes;
  parentURL?: string;
  [key: string]: unknown;
};
export type LoadSource =
  | string
  | ArrayBuffer
  | NodeJS.ArrayBufferView
  | null
  | undefined;
export type LoadResult = {
  format?: string;
  shortCircuit?: boolean;
  source?: LoadSource;
};
export type ResolveResult = {
  format?: string;
  shortCircuit?: boolean;
  url: string;
};
export type HookData = {
  addHookMessagePort?: MessagePort;
  exclude?: never;
  include?: readonly string[];
  shouldInclude?: never;
};
export type AsyncLoadFunction = (
  url: string,
  context: LoaderContext,
) => LoadResult | Promise<LoadResult>;
export type SyncLoadFunction = (
  url: string,
  context: LoaderContext,
) => LoadResult;
export type AsyncResolveFunction = (
  specifier: string,
  context: LoaderContext,
) => ResolveResult | Promise<ResolveResult>;
export type SyncResolveFunction = (
  specifier: string,
  context: LoaderContext,
) => ResolveResult;

export interface ImportInTheMiddleHook {
  applyOptions(data: HookData): void;
  initialize(data?: HookData): Promise<void>;
  load(
    url: string,
    context: LoaderContext,
    parentLoad: AsyncLoadFunction,
  ): Promise<LoadResult>;
  loadSync(
    url: string,
    context: LoaderContext,
    nextLoad: SyncLoadFunction,
  ): LoadResult;
  resolve(
    specifier: string,
    context: LoaderContext,
    parentResolve: AsyncResolveFunction,
  ): Promise<ResolveResult>;
  resolveSync(
    specifier: string,
    context: LoaderContext,
    nextResolve: SyncResolveFunction,
  ): ResolveResult;
}

export function createHook(
  meta: { url: string },
  options?: { registerUrl?: string },
): ImportInTheMiddleHook;

export function supportsSyncHooks(): boolean;
