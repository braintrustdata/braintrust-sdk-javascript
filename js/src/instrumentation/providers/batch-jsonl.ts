import { isObject } from "../../../util";
import { debugLogger } from "../../debug-logger";
import type { OpenAIBatchFile } from "../../openai-batch-types";

function read(value: unknown, key: PropertyKey): unknown {
  if (!isObject(value)) {
    return undefined;
  }
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

function isBatchRecordIterable(
  value: unknown,
): value is Iterable<unknown> | AsyncIterable<unknown> {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return false;
  }
  return (
    typeof read(value, Symbol.iterator) === "function" ||
    typeof read(value, Symbol.asyncIterator) === "function"
  );
}

export async function* jsonlRecords(
  file: OpenAIBatchFile,
  onIssue: (error: Error) => void = () => {},
): AsyncGenerator<unknown> {
  const resolvedFile = await file;
  if (
    typeof resolvedFile === "string" ||
    resolvedFile instanceof Uint8Array ||
    resolvedFile instanceof ArrayBuffer ||
    (typeof Buffer !== "undefined" && Buffer.isBuffer(resolvedFile))
  ) {
    const text =
      typeof resolvedFile === "string"
        ? resolvedFile
        : new TextDecoder().decode(resolvedFile);
    for (const line of text.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      try {
        yield JSON.parse(line.replace(/\r$/, ""));
      } catch (error) {
        debugLogger.debug("skipped malformed JSONL", error);
        onIssue(new Error("Batch file contains malformed JSONL"));
      }
    }
    return;
  }

  const body = read(resolvedFile, "body");
  const getReader = read(body, "getReader");
  if (isObject(body) && typeof getReader === "function") {
    let reader: unknown;
    try {
      reader = Reflect.apply(getReader, body, []);
      const decoder = new TextDecoder();
      let pending = "";
      while (true) {
        const readChunk = read(reader, "read");
        if (typeof readChunk !== "function") {
          throw new Error("Response body stream has no read method");
        }
        const chunk = await Reflect.apply(readChunk, reader, []);
        if (!isObject(chunk)) {
          throw new Error("Response body stream returned an invalid chunk");
        }
        if (chunk.done === true) {
          pending += decoder.decode();
          break;
        }
        if (!(chunk.value instanceof Uint8Array)) {
          throw new Error("Response body stream returned a non-byte chunk");
        }
        pending += decoder.decode(chunk.value, { stream: true });
        let newline = pending.indexOf("\n");
        while (newline !== -1) {
          const line = pending.slice(0, newline).replace(/\r$/, "");
          pending = pending.slice(newline + 1);
          if (line.trim()) {
            try {
              yield JSON.parse(line);
            } catch (error) {
              debugLogger.debug("skipped malformed JSONL", error);
              onIssue(new Error("Batch file contains malformed JSONL"));
            }
          }
          newline = pending.indexOf("\n");
        }
      }
      if (pending.trim()) {
        try {
          yield JSON.parse(pending.replace(/\r$/, ""));
        } catch (error) {
          debugLogger.debug("skipped malformed JSONL", error);
          onIssue(new Error("Batch file contains malformed JSONL"));
        }
      }
    } catch (error) {
      debugLogger.debug("could not read JSONL response body", error);
      onIssue(new Error("Batch response body could not be read"));
    } finally {
      const releaseLock = read(reader, "releaseLock");
      if (typeof releaseLock === "function") {
        try {
          Reflect.apply(releaseLock, reader, []);
        } catch (error) {
          debugLogger.debug("could not release stream reader", error);
        }
      }
    }
    return;
  }

  if (Array.isArray(resolvedFile) || isBatchRecordIterable(resolvedFile)) {
    for await (const record of resolvedFile) {
      yield record;
    }
    return;
  }

  debugLogger.debug("Skipped invalid batch JSONL source");
  onIssue(new Error("Batch file source is invalid"));
}
