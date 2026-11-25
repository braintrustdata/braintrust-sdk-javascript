import {
  deterministicDigest,
  digestHex,
  digestUuid,
} from "./instrumentation/providers/openai-manual-instrumentation-utils";
import { SpanTypeAttribute, isObject } from "../util";
import { SpanComponentsV4 } from "../util/span_identifier_v4";
import { debugLogger } from "./debug-logger";
import {
  _internalStartSpanWithInitialMergeAndParentSpanIds,
  _internalStartSpanWithInitialMerge,
  getSpanParentObject,
  withCurrent,
  NOOP_SPAN,
  updateSpan,
} from "./logger/core";
import {
  INSTRUMENTATION_NAMES,
  withSpanInstrumentationName,
} from "./span-origin";
import { getCurrentUnixTimestamp } from "./util";
import { jsonlRecords } from "./instrumentation/providers/batch-jsonl";
import { extractOpenAIBatchInput } from "./instrumentation/providers/openai-span-data";
import {
  extractGroqAudioInput,
  extractGroqAudioTextOutput,
  parseGroqMetrics,
} from "./instrumentation/providers/groq-instrumentation";
import { serviceTierMetadata } from "./instrumentation/core/service-tier";

interface GroqBatch {
  id: string;
  input_file_id: string;
  endpoint: string;
  status: string;
  created_at?: number | null;
  completed_at?: number | null;
  failed_at?: number | null;
  cancelled_at?: number | null;
  expired_at?: number | null;
  request_counts?: { total: number; completed: number; failed: number } | null;
}

// Only already obtained data. Iterating a provider paginator can trigger requests.
type BatchFile = string | Response | readonly unknown[];

function readBatchFile(file: BatchFile) {
  if (
    typeof file !== "string" &&
    !Array.isArray(file) &&
    !(file instanceof Response)
  ) {
    throw new Error(
      "Groq batch capture requires JSONL, a file response, or parsed records",
    );
  }
  return jsonlRecords(file, (error) => {
    throw error;
  });
}

const spanNames = new Map([
  ["/v1/chat/completions", "groq.chat.completions.create"],
  ["/v1/audio/transcriptions", "groq.audio.transcriptions.create"],
  ["/v1/audio/translations", "groq.audio.translations.create"],
]);

interface BatchContext {
  version: 1;
  batchId: string;
  inputFileId: string;
  endpoint: string;
  task: string;
  startTime: number;
  requestIds: string[];
}

/** Start capture after Groq accepts the batch. Supply its input JSONL, a file
 * response, or parsed records. Persist the returned string with the batch in
 * trusted application storage and flush the logger before handing off work.
 * The context stores routing data and request IDs. */
export async function startGroqBatchTrace({
  batch,
  inputFileContent,
}: {
  batch: GroqBatch;
  inputFileContent: BatchFile;
}): Promise<string | undefined> {
  try {
    const name = spanNames.get(batch.endpoint);
    if (!name || !batch.id || !batch.input_file_id) return;
    const startTime = batch.created_at ?? getCurrentUnixTimestamp();
    const parent = getSpanParentObject();
    if (parent === NOOP_SPAN) return;
    const parentSlug =
      "toStr" in parent ? parent.toStr() : await parent.export();
    const routing = SpanComponentsV4.fromStr(parentSlug);
    const digest = await deterministicDigest("groq:batch", batch.id);
    const task = withCurrent(NOOP_SPAN, () =>
      _internalStartSpanWithInitialMergeAndParentSpanIds(
        withSpanInstrumentationName(
          {
            parent: parentSlug,
            spanId: digestHex(digest, 8),
            ...(!routing.data.span_id
              ? {
                  parentSpanIds: {
                    parentSpanIds: [],
                    rootSpanId: digestHex(digest, 16),
                  },
                }
              : {}),
            name: "groq.batch",
            type: SpanTypeAttribute.TASK,
            startTime,
            event: {
              id: digestUuid(digest),
              metadata: {
                provider: "groq",
                batch_id: batch.id,
                input_file_id: batch.input_file_id,
                endpoint: batch.endpoint,
                status: batch.status,
              },
            },
          },
          INSTRUMENTATION_NAMES.GROQ,
        ),
      ),
    );
    const taskSlug = await task.export();
    const requestIds = new Set<string>();
    for await (const row of readBatchFile(inputFileContent)) {
      if (
        !isObject(row) ||
        typeof row.custom_id !== "string" ||
        !row.custom_id ||
        requestIds.has(row.custom_id) ||
        row.method !== "POST" ||
        row.url !== batch.endpoint ||
        !isObject(row.body) ||
        typeof row.body.model !== "string"
      ) {
        throw new Error("Invalid Groq batch input record");
      }
      const digest = await deterministicDigest(
        "groq:batch:request",
        batch.id,
        row.custom_id,
      );
      const child = withCurrent(NOOP_SPAN, () =>
        _internalStartSpanWithInitialMerge(
          withSpanInstrumentationName(
            {
              parent: taskSlug,
              spanId: digestHex(digest, 8),
              event: { id: digestUuid(digest) },
              name,
              type: SpanTypeAttribute.LLM,
              startTime,
            },
            INSTRUMENTATION_NAMES.GROQ,
          ),
        ),
      );
      const data =
        batch.endpoint === "/v1/chat/completions"
          ? extractOpenAIBatchInput(batch.endpoint, row.body)
          : extractGroqAudioInput(
              { ...row.body, model: row.body.model },
              batch.endpoint === "/v1/audio/translations"
                ? "translate"
                : "transcribe",
              child,
            );
      child.log({
        ...data,
        metadata: {
          ...data.metadata,
          provider: "groq",
          custom_id: row.custom_id,
        },
      });
      requestIds.add(row.custom_id);
    }
    const taskRouting = SpanComponentsV4.fromStr(taskSlug);
    const context: BatchContext = {
      version: 1,
      batchId: batch.id,
      inputFileId: batch.input_file_id,
      endpoint: batch.endpoint,
      startTime,
      requestIds: [...requestIds],
      task: new SpanComponentsV4({
        ...taskRouting.data,
        propagated_event: undefined,
      }).toStr(),
    };
    return JSON.stringify(context);
  } catch (error) {
    debugLogger.debug("Could not capture Groq batch inputs", error);
    return undefined;
  }
}

/** Finish a previously started batch with the terminal Groq batch and its
 * downloaded output and error files. Responses are consumed once. To retry,
 * pass fresh file contents with the same saved context. If submission was
 * not traced, supply the original input file to capture the whole batch under
 * the current parent. */
export async function completeGroqBatchTrace(
  args: {
    batch: GroqBatch;
    outputFileContent?: BatchFile;
    errorFileContent?: BatchFile;
  } & ({ context: string } | { inputFileContent: BatchFile }),
): Promise<void> {
  const { batch, outputFileContent, errorFileContent } = args;
  try {
    const context =
      "context" in args ? args.context : await startGroqBatchTrace(args);
    if (!context) return;
    const saved: BatchContext = JSON.parse(context);
    if (
      saved.version !== 1 ||
      saved.batchId !== batch.id ||
      saved.inputFileId !== batch.input_file_id ||
      saved.endpoint !== batch.endpoint
    )
      throw new Error("Groq batch trace context mismatch");
    const terminalTimes: Record<string, number | null | undefined> = {
      completed: batch.completed_at,
      cancelled: batch.cancelled_at,
      expired: batch.expired_at,
      failed: batch.failed_at,
    };
    if (!Object.hasOwn(terminalTimes, batch.status)) return;
    const end = Math.max(
      saved.startTime,
      terminalTimes[batch.status] ?? getCurrentUnixTimestamp(),
    );
    const task = SpanComponentsV4.fromStr(saved.task);
    if (
      task.data.row_id !==
        digestUuid(await deterministicDigest("groq:batch", batch.id)) ||
      !task.data.root_span_id ||
      !Array.isArray(saved.requestIds) ||
      !Number.isFinite(saved.startTime)
    )
      throw new Error("Invalid Groq batch context");
    const rootSpanId = task.data.root_span_id;
    const remaining = new Set(saved.requestIds);
    async function takeChild(id: unknown): Promise<string> {
      if (typeof id !== "string" || !remaining.delete(id))
        throw new Error("Unknown or duplicate Groq batch result ID");
      const digest = await deterministicDigest(
        "groq:batch:request",
        batch.id,
        id,
      );
      return new SpanComponentsV4({
        ...task.data,
        root_span_id: rootSpanId,
        row_id: digestUuid(digest),
        span_id: digestHex(digest, 8),
      }).toStr();
    }
    for (const file of [outputFileContent, errorFileContent]) {
      if (file === undefined) continue;
      for await (const row of readBatchFile(file)) {
        if (!isObject(row)) throw new Error("Invalid Groq batch result");
        const exported = await takeChild(row.custom_id);
        const response = isObject(row.response) ? row.response : undefined;
        const body = response?.body;
        const error = row.error ?? (isObject(body) ? body.error : undefined);
        if (
          error ||
          file === errorFileContent ||
          (typeof response?.status_code === "number" &&
            response.status_code >= 400)
        ) {
          updateSpan({
            exported,
            error: new Error(
              isObject(error) && typeof error.message === "string"
                ? error.message
                : "Groq batch request failed",
            ),
            metrics: { end },
          });
        } else {
          const chat = batch.endpoint === "/v1/chat/completions";
          if (
            chat
              ? !isObject(body) || !Array.isArray(body.choices)
              : !isObject(body) && typeof body !== "string"
          )
            throw new Error("Invalid Groq batch response body");
          const result = isObject(body) ? body : {};
          updateSpan({
            exported,
            output: chat
              ? result.choices
              : extractGroqAudioTextOutput(
                  typeof body === "string" ? body : result,
                ),
            metadata: {
              ...(typeof result.model === "string"
                ? { model: result.model }
                : {}),
              ...serviceTierMetadata({ served: result.service_tier }),
            },
            metrics: { ...parseGroqMetrics(result), end },
          });
        }
      }
    }
    if (
      batch.status === "completed" &&
      (remaining.size ||
        (batch.request_counts &&
          batch.request_counts.total !== saved.requestIds.length))
    ) {
      debugLogger.debug("Groq batch results are incomplete");
      return;
    }
    const error =
      batch.status === "completed"
        ? undefined
        : new Error(`Groq batch ${batch.status}`);
    for (const id of remaining.keys())
      updateSpan({ exported: await takeChild(id), error, metrics: { end } });
    updateSpan({
      exported: saved.task,
      error,
      metrics: { end },
      metadata: { status: batch.status, request_counts: batch.request_counts },
    });
  } catch (error) {
    debugLogger.debug("Could not complete Groq batch trace", error);
  }
}
