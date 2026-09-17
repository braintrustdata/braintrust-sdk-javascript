import {
  completeMistralBatchTraceImpl,
  failMistralBatchCreateTraceImpl,
  MISTRAL_BATCH_MAX_CORRELATION_BYTES,
  prepareMistralBatchTraceImpl,
} from "./instrumentation/plugins/mistral-batch-instrumentation";
import { getSpanParentObject } from "./logger";
import { LRUCache } from "./lru-cache";
import type {
  CompleteMistralBatchTraceArgs,
  MistralBatchCollectionContext,
  MistralBatchCreateParams,
  MistralBatchFileLike,
  MistralBatchInput,
  MistralBatchInputFileContent,
  MistralBatchJobsResource,
  MistralBatchLike,
  MistralBatchRequestLike,
  MistralFilesResource,
} from "./mistral-batch-types";

const MAX_PENDING_BATCH_FILES = 1_000;
const pendingBatchFiles = new LRUCache<string, MistralBatchInputFileContent>({
  max: MAX_PENDING_BATCH_FILES,
});

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

type UploadBranches<TParams> = {
  params: TParams;
  inputFileContent: MistralBatchInputFileContent;
};

async function bufferTraceStream(
  stream: ReadableStream<Uint8Array>,
): Promise<Response> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let reachedEof = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        reachedEof = true;
        break;
      }
      if (
        totalBytes + chunk.value.byteLength >
        MISTRAL_BATCH_MAX_CORRELATION_BYTES
      ) {
        throw new Error(
          "Mistral Batch input exceeds the tracing correlation byte limit",
        );
      }
      chunks.push(chunk.value);
      totalBytes += chunk.value.byteLength;
    }
  } finally {
    if (!reachedEof) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }

  const content = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(content);
}

function splitUpload<TParams>(params: TParams): UploadBranches<TParams> | null {
  if (read(params, "purpose") !== "batch") {
    return null;
  }

  const file = read(params, "file");
  if (file instanceof Blob) {
    return {
      params,
      inputFileContent: () => new Response(file.slice()),
    };
  }

  const fileName = read(file, "fileName");
  const content = read(file, "content");
  if (typeof fileName !== "string") {
    return null;
  }

  let uploadContent: unknown;
  let inputFileContent: MistralBatchInputFileContent;
  if (content instanceof Blob) {
    uploadContent = content;
    inputFileContent = () => new Response(content.slice());
  } else if (content instanceof ArrayBuffer) {
    uploadContent = content;
    inputFileContent = () => new Response(content.slice(0));
  } else if (content instanceof Uint8Array) {
    uploadContent = content;
    inputFileContent = () => new Response(content.slice());
  } else if (content instanceof ReadableStream) {
    const [upload, trace] = content.tee();
    uploadContent = upload;
    const bufferedTrace = bufferTraceStream(trace);
    void bufferedTrace.catch(() => undefined);
    inputFileContent = bufferedTrace;
  } else {
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const tracedParams = {
    ...Object(params),
    file: { ...Object(file), content: uploadContent },
  } as TParams;
  return { params: tracedParams, inputFileContent };
}

function takeBatchInput(params: unknown): MistralBatchInput | undefined {
  const requests = read(params, "requests");
  const inputFiles = read(params, "inputFiles");
  const hasRequests = Array.isArray(requests) && requests.length > 0;
  const hasInputFiles = Array.isArray(inputFiles) && inputFiles.length > 0;
  if (hasRequests === hasInputFiles) {
    return undefined;
  }
  if (hasRequests) {
    return {
      // Runtime validation is handled by the batch instrumentation parser.
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      requests: requests as MistralBatchRequestLike[],
    };
  }
  if (!Array.isArray(inputFiles)) {
    return undefined;
  }

  const files: Array<{
    file: { id: string };
    content: MistralBatchInputFileContent;
  }> = [];
  for (const fileId of inputFiles) {
    if (typeof fileId !== "string") {
      return undefined;
    }
    const content = pendingBatchFiles.get(fileId);
    if (content === undefined) {
      return undefined;
    }
    files.push({ file: { id: fileId }, content });
  }
  for (const fileId of inputFiles) {
    pendingBatchFiles.delete(fileId);
  }
  return { files };
}

/**
 * Wrap `mistral.files.upload` so a later traced Batch create can read the
 * uploaded JSONL without changing the bytes sent to Mistral.
 *
 * Pass the `mistral.files` resource, then call the returned function with the
 * same arguments as `mistral.files.upload`. Files whose purpose is not `batch`
 * are passed through without tracing. Use each traced input file in one Batch
 * create call.
 *
 * @example
 * ```ts
 * const inputFile = await mistralFilesUploadTraced(mistral.files)({
 *   file: new Blob([batchJSONL]),
 *   purpose: "batch",
 * });
 * ```
 */
export function mistralFilesUploadTraced<
  TParams,
  TFile extends MistralBatchFileLike,
  TOptions = unknown,
>(
  files: MistralFilesResource<TParams, TFile, TOptions>,
): (params: TParams, options?: TOptions) => Promise<TFile> {
  return async (params, options) => {
    let branches: UploadBranches<TParams> | null;
    try {
      branches = splitUpload(params);
    } catch {
      branches = null;
    }

    const file = await files.upload(branches?.params ?? params, options);
    if (branches) {
      pendingBatchFiles.set(file.id, branches.inputFileContent);
    }
    return file;
  };
}

/**
 * Wrap `mistral.batch.jobs.create` to start a Batch trace and automatically
 * close it if submission fails.
 *
 * Inline requests are read directly from the create parameters. File inputs
 * must first be uploaded through `mistralFilesUploadTraced` in this process.
 *
 * @example
 * ```ts
 * const batch = await mistralBatchJobsCreateTraced(mistral.batch.jobs)({
 *   inputFiles: [inputFile.id],
 *   endpoint: "/v1/chat/completions",
 *   model: "mistral-small-latest",
 * });
 * ```
 */
export function mistralBatchJobsCreateTraced<
  TParams,
  TBatch extends MistralBatchLike,
  TOptions = unknown,
>(
  jobs: MistralBatchJobsResource<TParams, TBatch, TOptions>,
): (params: TParams, options?: TOptions) => Promise<TBatch> {
  return async (params, options) => {
    const input = takeBatchInput(params);
    if (!input) {
      return await jobs.create(params, options);
    }

    const trace = await prepareMistralBatchTraceImpl({
      input,
      // The provider-specific shape is validated before tracing starts.
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      params: params as MistralBatchCreateParams,
    });
    try {
      // The trace helper only returns a shallow copy with provider-supported
      // input and metadata fields added.
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      return await jobs.create(trace.params as TParams, options);
    } catch (error) {
      await failMistralBatchCreateTraceImpl(trace, error);
      throw error;
    }
  };
}

/**
 * Add result data to a Mistral Batch trace.
 *
 * This helper performs no Mistral API requests. Pass the original inline
 * requests or the contents of every input file, plus downloaded output/error
 * file contents when results were not returned inline on `batch.outputs`.
 * Persist the returned collection context and pass it as `collectionContext`
 * if a collect-only completion needs to be retried.
 *
 * @example
 * ```ts
 * await completeMistralBatchTrace({
 *   batch,
 *   inputFileContents: [
 *     {
 *       fileId: inputFile.id,
 *       content: await mistral.files.download({ fileId: inputFile.id }),
 *     },
 *   ],
 *   outputFileContent: batch.outputFile
 *     ? await mistral.files.download({ fileId: batch.outputFile })
 *     : undefined,
 *   errorFileContent: batch.errorFile
 *     ? await mistral.files.download({ fileId: batch.errorFile })
 *     : undefined,
 * });
 * ```
 */
export async function completeMistralBatchTrace<
  TBatch extends MistralBatchLike,
>(
  args: CompleteMistralBatchTraceArgs<TBatch>,
): Promise<MistralBatchCollectionContext | undefined> {
  const input: MistralBatchInput =
    args.requests !== undefined
      ? { requests: args.requests }
      : {
          files: args.inputFileContents.map(({ fileId, content }) => ({
            file: { id: fileId },
            content,
          })),
        };
  const outputContent =
    args.outputFileContent === undefined
      ? undefined
      : Promise.resolve(args.outputFileContent);
  const errorContent =
    args.errorFileContent === undefined
      ? undefined
      : Promise.resolve(args.errorFileContent);

  void outputContent?.catch(() => undefined);
  void errorContent?.catch(() => undefined);

  return await completeMistralBatchTraceImpl(
    {
      batch: args.batch,
      input,
      outputContent,
      errorContent,
      collectionContext: args.collectionContext,
      onTraceError: args.onTraceError,
    },
    getSpanParentObject(),
  );
}
