// The export-collection logic (resolving star re-exports, reading source,
// parsing exports) is identical whether `import-in-the-middle` runs as an
// off-thread loader (`module.register`, asynchronous `nextResolve`/`nextLoad`)
// or as an in-thread synchronous loader (`module.registerHooks`). To keep a
// single implementation of that logic — instead of two copies that drift — it
// is written as "sans-io" generators that `yield` the I/O they need and let a
// driver fulfil it. The async driver awaits; the sync driver calls straight
// through. Everything between the yields is shared.

// Operation kinds a loader generator may yield. Each is `[KIND, ...args]`.
export const LOAD = 0; // [LOAD, url, context]      -> resolves to { source, format }
export const RESOLVE = 1; // [RESOLVE, specifier, context] -> resolves to { url, format }

export type LoaderAttributes = Record<string, string | undefined>;
export type LoaderContext = {
  conditions?: string[];
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
export type LoadOperation = [typeof LOAD, string, LoaderContext];
export type ResolveOperation = [typeof RESOLVE, string, LoaderContext];
export type LoaderOperation = LoadOperation | ResolveOperation;
type SyncLoaderIo = {
  load: (url: string, context: LoaderContext) => LoadResult;
  resolve?: (specifier: string, context: LoaderContext) => ResolveResult;
};
type AsyncLoaderIo = {
  load: (url: string, context: LoaderContext) => Promise<LoadResult>;
  resolve?: (
    specifier: string,
    context: LoaderContext,
  ) => Promise<ResolveResult>;
};

function runOp(
  op: LoaderOperation,
  io: SyncLoaderIo,
): LoadResult | ResolveResult;
function runOp(
  op: LoaderOperation,
  io: AsyncLoaderIo,
): Promise<LoadResult | ResolveResult>;
function runOp(
  op: LoaderOperation,
  io: SyncLoaderIo | AsyncLoaderIo,
): LoadResult | ResolveResult | Promise<LoadResult | ResolveResult> {
  if (op[0] === RESOLVE) {
    if (!io.resolve) {
      throw new Error("resolve operation yielded without a resolve function");
    }
    return io.resolve(op[1], op[2]);
  }
  return io.load(op[1], op[2]);
}

/**
 * Drives a loader generator to completion, fulfilling each yielded I/O
 * operation synchronously. Used with `module.registerHooks`, whose
 * `nextResolve`/`nextLoad` return their result directly.
 *
 * Errors from I/O are thrown back into the generator (via `gen.throw`) so its
 * `try`/`finally` blocks run exactly as they would for an `await` rejection.
 *
 * @template T
 * @param {Generator<LoaderOperation, T, LoadResult | ResolveResult>} gen
 * @param {SyncLoaderIo} io
 * @returns {T}
 */
export function driveSync<T>(
  gen: Generator<LoaderOperation, T, LoadResult | ResolveResult>,
  io: SyncLoaderIo,
): T {
  let next = gen.next();
  while (next.done === false) {
    try {
      next = gen.next(runOp(next.value, io));
    } catch (err) {
      next = gen.throw(err);
    }
  }
  return next.value as T;
}

/**
 * Drives a loader generator to completion, awaiting each yielded I/O
 * operation. Used with the off-thread `module.register` loader, whose
 * `nextResolve`/`nextLoad` are asynchronous.
 *
 * @template T
 * @param {Generator<LoaderOperation, T, LoadResult | ResolveResult>} gen
 * @param {AsyncLoaderIo} io
 * @returns {Promise<T>}
 */
export async function driveAsync<T>(
  gen: Generator<LoaderOperation, T, LoadResult | ResolveResult>,
  io: AsyncLoaderIo,
): Promise<T> {
  let next = gen.next();
  while (next.done === false) {
    try {
      next = gen.next(await runOp(next.value, io));
    } catch (err) {
      next = gen.throw(err);
    }
  }
  return next.value as T;
}
