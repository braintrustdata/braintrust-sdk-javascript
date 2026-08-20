import { openAIChannels } from "./instrumentation/plugins/openai-channels";
import { getSpanParentObject } from "./logger";
import {
  createLazyAPIPromise,
  type EnhancedResponse,
} from "./wrappers/openai-promise-utils";
import type {
  CompleteOpenAIBatchTraceArgs,
  OpenAIAPIPromise,
  OpenAIBatchLike,
  OpenAIBatchesResource,
  OpenAIBatchFileContent,
  OpenAIFileLike,
  OpenAIFilesResource,
} from "./openai-batch-types";

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
            "OpenAI upload streams must yield Uint8Array chunks",
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
): { upload: unknown; trace: OpenAIBatchFileContent } | undefined {
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
 * Wrap `openai.files.create` to trace an OpenAI Batch input file upload.
 *
 * Pass the `openai.files` resource, then call the returned function with the
 * same arguments as `openai.files.create`. Files whose purpose is not `batch`
 * are passed through without tracing. Blob and Response uploads are copied for
 * tracing; async-iterable uploads (including Node file streams) are teed so the
 * exact bytes still flow to OpenAI while Braintrust reads a separate branch.
 *
 * The returned input file ID identifies the trace. Each request span is
 * identified by that file ID and its JSONL `custom_id`, so use every traced
 * input file for only one OpenAI Batch.
 *
 * @example
 * ```ts
 * const inputFile = await openaiFilesCreateTraced(openai.files)({
 *   file: createReadStream("batch.jsonl"),
 *   purpose: "batch",
 * });
 * ```
 */
export function openaiFilesCreateTraced<
  TParams,
  TFile extends OpenAIFileLike,
  TOptions = unknown,
>(
  files: OpenAIFilesResource<TParams, TFile, TOptions>,
): (params: TParams, options?: TOptions) => OpenAIAPIPromise<TFile> {
  return (params, options) => {
    const parent = getSpanParentObject();
    const purpose = read(params, "purpose");
    const file = read(params, "file");
    if (purpose !== "batch") {
      return files.create(params, options);
    }

    let branches: ReturnType<typeof teeUpload>;
    try {
      branches = teeUpload(file);
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
    const tracedResponse = openAIChannels.filesCreateTraced
      .invoke(
        async () => {
          enhancedResponse = await apiPromise.withResponse();
          return enhancedResponse.data;
        },
        files,
        [{ params, inputFileContent: branches.trace, parent }],
        {},
      )
      .then((data) => {
        if (!enhancedResponse) {
          throw new Error(
            "Expected OpenAI withResponse() to provide a response",
          );
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
 * Wrap `openai.batches.retrieve` to update an OpenAI Batch trace with the
 * server-recorded lifecycle timestamps and close its spans at a terminal
 * status.
 *
 * Pass the `openai.batches` resource, then call the returned function with the
 * same arguments as `openai.batches.retrieve`. The Batch must use an input file
 * previously uploaded through `openaiFilesCreateTraced` in this process.
 *
 * @example
 * ```ts
 * const batch = await openaiBatchesRetrieveTraced(openai.batches)(batchId);
 * ```
 */
export function openaiBatchesRetrieveTraced<
  TBatch extends OpenAIBatchLike,
  TOptions = unknown,
>(
  batches: OpenAIBatchesResource<TBatch, TOptions>,
): (batchId: string, options?: TOptions) => OpenAIAPIPromise<TBatch> {
  return (batchId, options) => {
    const apiPromise = batches.retrieve(batchId, options);
    let enhancedResponse: EnhancedResponse<TBatch> | undefined;
    const tracedResponse = openAIChannels.batchesRetrieveTraced
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
          throw new Error(
            "Expected OpenAI withResponse() to provide a response",
          );
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
 * Add result data to spans created by `openaiFilesCreateTraced`.
 *
 * This helper performs no OpenAI API requests. Pass the input file ID and the
 * input, output, and error contents returned by `openai.files.content`, or pass
 * JSONL strings/iterables directly. Response bodies are consumed. Call
 * `openaiBatchesRetrieveTraced` first when exact OpenAI lifecycle timestamps
 * are available.
 *
 * @example
 * ```ts
 * const outputFileContent = batch.output_file_id
 *   ? await openai.files.content(batch.output_file_id)
 *   : undefined;
 * const errorFileContent = batch.error_file_id
 *   ? await openai.files.content(batch.error_file_id)
 *   : undefined;
 * await completeOpenAIBatchTrace({
 *   inputFileId: batch.input_file_id,
 *   inputFileContent: await openai.files.content(batch.input_file_id),
 *   outputFileContent,
 *   errorFileContent,
 * });
 * ```
 */
export async function completeOpenAIBatchTrace(
  args: CompleteOpenAIBatchTraceArgs,
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

  await openAIChannels.batchesCompleteTrace.invoke(
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
