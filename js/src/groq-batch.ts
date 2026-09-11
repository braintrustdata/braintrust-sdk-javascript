import { groqChannels } from "./instrumentation/plugins/groq-channels";
import { getSpanParentObject } from "./logger";
import {
  createLazyAPIPromise,
  type EnhancedResponse,
} from "./wrappers/openai-promise-utils";
import type {
  BindGroqBatchTraceArgs,
  CollectGroqBatchTraceArgs,
  CompleteGroqBatchTraceArgs,
  FailGroqBatchTraceArgs,
  GroqAPIPromise,
  GroqBatchCreateParams,
  GroqBatchLike,
  GroqBatchesCreateResource,
  GroqBatchesRetrieveResource,
  GroqBatchTraceContext,
  GroqFileLike,
  GroqFilesResource,
  StartGroqBatchTraceArgs,
} from "./groq-batch-types";

function read(value: unknown, key: PropertyKey): unknown {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return undefined;
  }
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof read(value, Symbol.asyncIterator) === "function";
}

function teeAsyncIterable(source: AsyncIterable<unknown>): {
  upload: AsyncIterable<Uint8Array>;
  trace: Response;
} {
  const iterator = source[Symbol.asyncIterator]();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await iterator.next();
        if (result.done) {
          controller.close();
          return;
        }
        if (!(result.value instanceof Uint8Array)) {
          throw new TypeError(
            "Groq upload streams must yield Uint8Array chunks",
          );
        }
        controller.enqueue(result.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await iterator.return?.(reason);
    },
  });
  const [uploadStream, trace] = stream.tee();
  const upload = {
    async *[Symbol.asyncIterator]() {
      const reader = uploadStream.getReader();
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) {
            return;
          }
          yield result.value;
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
  const path = read(source, "path");
  if (typeof path === "string") {
    Object.defineProperty(upload, "path", { value: path });
  }
  return { upload, trace: new Response(trace) };
}

function teeUpload(
  upload: unknown,
): { upload: unknown; trace: Response } | undefined {
  if (upload instanceof Blob) {
    return { upload, trace: new Response(upload) };
  }
  if (upload instanceof Response) {
    return { upload, trace: upload.clone() };
  }
  if (isAsyncIterable(upload)) {
    return teeAsyncIterable(upload);
  }
  return undefined;
}

/**
 * Wrap `groq.files.create` to trace a Groq Batch input file upload.
 *
 * Pass the `groq.files` resource, then call the returned function with the
 * same arguments as `groq.files.create`. Files whose purpose is not `batch`
 * pass through without tracing. Blob and Response uploads are copied for
 * tracing; async-iterable uploads (including Node file streams) are teed so
 * the same bytes still flow to Groq while Braintrust retains a separate copy.
 *
 * Use each traced input file for only one Groq Batch.
 *
 * @example
 * ```ts
 * const inputFile = await groqFilesCreateTraced(groq.files)({
 *   file: createReadStream("batch.jsonl"),
 *   purpose: "batch",
 * });
 * ```
 */
export function groqFilesCreateTraced<
  TParams,
  TFile extends GroqFileLike,
  TOptions = unknown,
>(
  files: GroqFilesResource<TParams, TFile, TOptions>,
): (params: TParams, options?: TOptions) => GroqAPIPromise<TFile> {
  return (params, options) => {
    if (read(params, "purpose") !== "batch") {
      return files.create(params, options);
    }

    let branches: ReturnType<typeof teeUpload>;
    try {
      branches = teeUpload(read(params, "file"));
    } catch {
      return files.create(params, options);
    }
    if (!branches) {
      return files.create(params, options);
    }

    const tracedParams = {
      ...Object(params),
      file: branches.upload,
    } as TParams;
    const apiPromise = files.create(tracedParams, options);
    let enhancedResponse: EnhancedResponse<TFile> | undefined;
    const tracedResponse = groqChannels.filesCreateTraced
      .invoke(
        async () => {
          enhancedResponse = await apiPromise.withResponse();
          return enhancedResponse.data;
        },
        files,
        [
          {
            inputFileContent: branches.trace,
            parent: getSpanParentObject(),
          },
        ],
        {},
      )
      .then((data) => {
        if (!enhancedResponse) {
          throw new Error("Expected Groq withResponse() to provide a response");
        }
        return { ...enhancedResponse, data };
      });

    return createLazyAPIPromise(
      () => tracedResponse,
      () => tracedResponse.then(({ response }) => response),
      () => apiPromise,
    );
  };
}

/**
 * Wrap `groq.batches.create` to start pending batch spans, inject resumable
 * trace metadata, bind the accepted Groq batch ID, and record submission
 * failures without changing the provider call's result.
 *
 * Pass the `groq.batches` resource, then call the returned function with the
 * same arguments as `groq.batches.create`. The input file must have been
 * uploaded through `groqFilesCreateTraced` in this process.
 *
 * @example
 * ```ts
 * const batch = await groqBatchesCreateTraced(groq.batches)({
 *   completion_window: "24h",
 *   endpoint: "/v1/chat/completions",
 *   input_file_id: inputFile.id,
 * });
 * ```
 */
export function groqBatchesCreateTraced<
  TParams,
  TBatch extends GroqBatchLike,
  TOptions = unknown,
>(
  batches: GroqBatchesCreateResource<TParams, TBatch, TOptions>,
): (params: TParams, options?: TOptions) => GroqAPIPromise<TBatch> {
  return (params, options) => {
    let apiPromise: GroqAPIPromise<TBatch> | undefined;
    let enhancedResponse: EnhancedResponse<TBatch> | undefined;
    const tracedResponse = groqChannels.batchesCreateTraced
      .invoke(
        async (input) => {
          apiPromise = batches.create(input.params as TParams, options);
          enhancedResponse = await apiPromise.withResponse();
          return enhancedResponse.data;
        },
        batches,
        [{ params }],
        {},
      )
      .then((data) => {
        if (!enhancedResponse) {
          throw new Error("Expected Groq withResponse() to provide a response");
        }
        return { ...enhancedResponse, data };
      });

    const providerPromise = () => {
      if (!apiPromise) {
        throw new Error("Expected Groq batch creation to start");
      }
      return apiPromise;
    };
    return createLazyAPIPromise(
      () => tracedResponse,
      async () => (await tracedResponse).response,
      providerPromise,
    );
  };
}

/**
 * Wrap `groq.batches.retrieve` to retain the Groq batch-ID correlation and
 * provider lifecycle timestamps used when the trace is completed.
 *
 * @example
 * ```ts
 * const batch = await groqBatchesRetrieveTraced(groq.batches)(batchId);
 * ```
 */
export function groqBatchesRetrieveTraced<
  TBatch extends GroqBatchLike,
  TOptions = unknown,
>(
  batches: GroqBatchesRetrieveResource<TBatch, TOptions>,
): (batchId: string, options?: TOptions) => GroqAPIPromise<TBatch> {
  return (batchId, options) => {
    const apiPromise = batches.retrieve(batchId, options);
    let enhancedResponse: EnhancedResponse<TBatch> | undefined;
    const tracedResponse = groqChannels.batchesRetrieveTraced
      .invoke(
        async () => {
          enhancedResponse = await apiPromise.withResponse();
          return enhancedResponse.data;
        },
        batches,
        [{ batchId }],
        {},
      )
      .then((data) => {
        if (!enhancedResponse) {
          throw new Error("Expected Groq withResponse() to provide a response");
        }
        return { ...enhancedResponse, data };
      });

    return createLazyAPIPromise(
      () => tracedResponse,
      () => tracedResponse.then(({ response }) => response),
      () => apiPromise,
    );
  };
}

/**
 * Add result data to a Groq Batch trace.
 *
 * This helper performs no Groq API requests. Pass the Batch returned by Groq
 * and the input, output, and error contents returned by `groq.files.content`,
 * or pass JSONL strings/iterables directly. Response bodies are consumed.
 *
 * @example
 * ```ts
 * const outputFileContent = batch.output_file_id
 *   ? await groq.files.content(batch.output_file_id)
 *   : undefined;
 * const errorFileContent = batch.error_file_id
 *   ? await groq.files.content(batch.error_file_id)
 *   : undefined;
 * await completeGroqBatchTrace({
 *   batch,
 *   inputFileContent: await groq.files.content(batch.input_file_id),
 *   outputFileContent,
 *   errorFileContent,
 * });
 * ```
 */
export async function completeGroqBatchTrace<TBatch extends GroqBatchLike>(
  args: CompleteGroqBatchTraceArgs<TBatch>,
): Promise<void> {
  const inputFileContent = Promise.resolve(args.inputFileContent);
  const outputFileContent =
    args.outputFileContent === undefined
      ? undefined
      : Promise.resolve(args.outputFileContent);
  const errorFileContent =
    args.errorFileContent === undefined
      ? undefined
      : Promise.resolve(args.errorFileContent);

  void inputFileContent.catch(() => undefined);
  void outputFileContent?.catch(() => undefined);
  void errorFileContent?.catch(() => undefined);

  await groqChannels.batchesCompleteTrace.invoke(
    async () => undefined,
    undefined,
    [
      {
        ...args,
        inputFileContent,
        outputFileContent,
        errorFileContent,
      },
    ],
    {},
  );
}

/**
 * Start a trace for a new Groq Batch, with pending spans for its requests, and
 * return the parameters to pass to `groq.batches.create()`.
 *
 * Only `/v1/chat/completions` batches are supported.
 * Iterable inputs must be supplied through a factory that returns a fresh
 * iterable on every call so submission failures can resume the pending spans.
 * Instrumentation enforces Groq's 50,000-record and 100 MB batch limits.
 * Inputs are validated in one pass and replayed for bounded streaming span
 * emission, supporting the full provider file limit.
 */
export async function startGroqBatchTrace(
  args: StartGroqBatchTraceArgs,
): Promise<GroqBatchCreateParams> {
  return await groqChannels.batchesStartTrace.invoke(
    async (input) => ({
      ...input.params,
      input_file_id: input.inputFile.id,
    }),
    undefined,
    [args],
    {},
  );
}

/**
 * Bind an accepted Groq Batch ID to the pending trace created by
 * `startGroqBatchTrace()`.
 *
 * Call this with the object returned by `groq.batches.create()`, then retain
 * the opaque result for `collectGroqBatchTrace()`. This helper performs no Groq
 * API requests and returns `undefined` when the batch has no valid pending
 * Braintrust context.
 */
export async function bindGroqBatchTrace<TBatch extends GroqBatchLike>(
  args: BindGroqBatchTraceArgs<TBatch>,
): Promise<GroqBatchTraceContext | undefined> {
  const result = await groqChannels.batchesBindTrace.invoke(
    async (): Promise<{ traceContext?: GroqBatchTraceContext }> => ({}),
    undefined,
    [args],
    {},
  );
  return result.traceContext;
}

/**
 * Collect a Groq Batch trace from caller-supplied Batch API data.
 *
 * This helper performs no Groq API requests. Supplied Response bodies are
 * consumed directly. Completed batches are validated and staged atomically in
 * a bounded 16 MiB result buffer before span updates are emitted. Result-file
 * factories are validated in one pass and replayed for bounded streaming
 * emission, supporting the full 100 MB provider limit. Without signed start
 * context, collect-only tracing also uses a bounded 16 MiB normalized-input
 * buffer and otherwise skips with a debug diagnostic. Files are limited to
 * Groq's 50,000-record and 100 MB limits. A trace started with
 * `startGroqBatchTrace()` also requires the opaque context returned by
 * `bindGroqBatchTrace()`. Local collection failures leave completed-batch
 * spans pending so callers can retry with fresh or replayable file sources.
 */
export async function collectGroqBatchTrace<TBatch extends GroqBatchLike>(
  args: CollectGroqBatchTraceArgs<TBatch>,
): Promise<TBatch> {
  const inputFile = Promise.resolve(args.inputFile);
  const outputFile =
    args.outputFile === undefined
      ? undefined
      : Promise.resolve(args.outputFile);
  const errorFile =
    args.errorFile === undefined ? undefined : Promise.resolve(args.errorFile);

  void inputFile.catch(() => undefined);
  void outputFile?.catch(() => undefined);
  void errorFile?.catch(() => undefined);

  const batch = await groqChannels.batchesCollectTrace.invoke(
    async (input) => input.batch,
    undefined,
    [{ ...args, inputFile, outputFile, errorFile }],
    {},
  );
  // The channel preserves the exact caller-supplied batch object, including
  // fields from newer Groq SDK versions.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return batch as TBatch;
}

/**
 * End a pending Groq Batch trace after `groq.batches.create()` rejects.
 *
 * The original replayable input is required to validate and resume every child
 * span. This helper performs no Groq API requests and never rethrows the
 * supplied error.
 */
export async function failGroqBatchTrace(
  args: FailGroqBatchTraceArgs,
): Promise<void> {
  await groqChannels.batchesFailTrace.invoke(
    async () => undefined,
    undefined,
    [args],
    {},
  );
}
