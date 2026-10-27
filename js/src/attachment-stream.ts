import { debugLogger } from "./debug-logger";

/** Describes incoming or transformed attachment bytes. */
export interface AttachmentStreamFormat {
  contentType: string;
  audio?: {
    sampleRate: number;
    channels: number;
    /** For example, `s16le` for signed 16-bit little-endian PCM. */
    sampleFormat?: string;
  };
}

export interface AttachmentStreamSource {
  format: AttachmentStreamFormat;
  /** Ordered, instrumentation-owned bytes. Single consumer; bytes may be modified. */
  chunks: AsyncIterable<Uint8Array>;
  /** Aborted when processing fails or output ends before the source does. */
  signal: AbortSignal;
  /** Desired file size in input bytes. A hint, never a mandatory file boundary. */
  targetFileInputBytes: number;
}

export interface AttachmentStreamFile {
  /** Audio output must describe `audio` and keep the source's channel count. */
  format: AttachmentStreamFormat;
  /** Defaults to a name derived from the content type. */
  filename?: string;
  /**
   * Bytes of one complete file. The SDK exhausts this iterable before requesting
   * the next file. Do not modify bytes after yielding them.
   */
  chunks: AsyncIterable<Uint8Array>;
  /**
   * Source time covered by this file, relative to the logical stream's start.
   * Files must be contiguous; yield a file without bytes to omit a range.
   * May be finalized while producing chunks; read after chunks are exhausted.
   * Required when a stream produces more than one file. A single file
   * consuming the entire source may omit it.
   */
  timeRange?: { startMs: number; endMs: number };
}

/**
 * Called once per captured logical stream. Keep encoder state in a closure or
 * generator. Register with initLogger({ attachmentStreamHook }); capture remains
 * opt-in, and ordinary Attachment instances are unaffected.
 *
 * Return undefined before consuming input to use default handling. An empty
 * iterable intentionally suppresses capture. Selected hooks never fall back to
 * uploading original bytes on failure; completed files remain valid.
 *
 * Output is currently buffered per file for upload. SDK-owned input and output
 * count against capture limits; customer encoder and worker allocations do not.
 * Hooks must cooperate with cancellation and settle pending work. Use finally
 * for cleanup, and never await flush() from inside a hook. flush() sends
 * pending logs first, then waits for uploads already started and for closed
 * streams to drain; it does not finish an active stream or force the hook to
 * end a file. Integrations that finalize on close, such as LiveKit sessions,
 * also wait for the closed stream to drain.
 *
 * Spans continuing an explicit parent and experiment spans don't use hooks.
 */
export type AttachmentStreamHook = (
  source: AttachmentStreamSource,
) =>
  | AsyncIterable<AttachmentStreamFile>
  | undefined
  | Promise<AsyncIterable<AttachmentStreamFile> | undefined>;

// Internal symbols also work when instrumentation and spans use different SDK bundles.
export const ATTACHMENT_STREAM_HOOK = Symbol.for(
  "braintrust.attachment-stream-hook",
);

export interface AttachmentStreamOptions {
  readonly [ATTACHMENT_STREAM_HOOK]?: AttachmentStreamHook;
}

/** An SDK-owned failure code, safe to report unlike customer hook errors. */
export class AttachmentStreamError extends Error {}

/** Consumes hook-owned file boundaries. The adapter owns source timing and capture. */
export class AttachmentStreamProcessor {
  private readonly controller = new AbortController();
  private inputBytes = 0;
  private outputBytes = 0;
  inputEnded = false;

  constructor(
    private readonly hook: AttachmentStreamHook,
    private readonly format: AttachmentStreamFormat,
    private readonly targetFileInputBytes: number,
    private readonly availableBytes: () => number,
  ) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get bufferedByteLength(): number {
    return this.inputBytes + this.outputBytes;
  }

  async run(
    input: AsyncIterable<Uint8Array>,
    onFile: (file: AttachmentStreamFile, data: Blob) => Promise<void>,
  ): Promise<boolean> {
    let inputIterator: AsyncIterator<Uint8Array> | undefined;
    let files: AsyncIterator<AttachmentStreamFile> | undefined;
    let chunks: AsyncIterator<Uint8Array> | undefined;
    let inputClosed = false;
    const source: AttachmentStreamSource = {
      format: {
        ...this.format,
        ...(this.format.audio ? { audio: { ...this.format.audio } } : {}),
      },
      signal: this.signal,
      targetFileInputBytes: this.targetFileInputBytes,
      chunks: {
        [Symbol.asyncIterator]: () => {
          if (inputIterator)
            throw new AttachmentStreamError(
              "attachment_stream_already_consumed",
            );
          const iterator = input[Symbol.asyncIterator]();
          inputIterator = iterator;
          return {
            next: async () => {
              this.inputBytes = 0;
              this.signal.throwIfAborted();
              const result = await iterator.next();
              this.signal.throwIfAborted();
              if (result.done) this.inputEnded = true;
              else {
                this.inputBytes = result.value.byteLength;
                if (this.bufferedByteLength > this.availableBytes())
                  throw new AttachmentStreamError("capture_byte_limit");
              }
              return result;
            },
            return: async () => {
              this.inputBytes = 0;
              // run() owns final cleanup; don't call return twice.
              inputClosed = true;
              return iterator.return
                ? await iterator.return()
                : { done: true, value: undefined };
            },
          };
        },
      },
    };
    let selected = false;
    try {
      this.signal.throwIfAborted();
      const output = await this.hook(source);
      if (output === undefined) {
        if (inputIterator)
          throw new AttachmentStreamError(
            "attachment_stream_declined_after_read",
          );
        return false;
      }
      selected = true;
      files = output[Symbol.asyncIterator]();
      while (true) {
        this.signal.throwIfAborted();
        const next = await files.next();
        this.signal.throwIfAborted();
        if (next.done) {
          files = undefined;
          break;
        }
        const file = next.value;
        if (
          !file.format?.contentType ||
          (file.filename !== undefined && !file.filename)
        )
          throw new AttachmentStreamError("attachment_stream_invalid_file");
        const parts: Uint8Array[] = [];
        chunks = file.chunks[Symbol.asyncIterator]();
        while (true) {
          const part = await chunks.next();
          this.signal.throwIfAborted();
          if (part.done) {
            chunks = undefined;
            break;
          }
          if (!(part.value instanceof Uint8Array))
            throw new AttachmentStreamError("attachment_stream_invalid_chunk");
          if (
            this.bufferedByteLength + part.value.byteLength >
            this.availableBytes()
          )
            throw new AttachmentStreamError("capture_byte_limit");
          if (part.value.byteLength) {
            parts.push(part.value);
            this.outputBytes += part.value.byteLength;
          }
        }
        const data = new Blob(parts, { type: file.format.contentType });
        parts.length = 0;
        await onFile(file, data);
        this.outputBytes = 0;
      }
      return true;
    } catch (error) {
      this.controller.abort();
      throw error;
    } finally {
      // Wake pending input reads before closing generators. Early output completion
      // intentionally abandons the remainder of the source.
      if (selected && !this.inputEnded) this.controller.abort();
      for (const iterator of [chunks, files, inputIterator]) {
        // Closing the file generator can itself close the source. Check after
        // each return(), rather than scheduling duplicate source cleanup.
        if (iterator === inputIterator && inputClosed) continue;
        try {
          await iterator?.return?.();
        } catch {
          // Customer errors may contain media or secrets.
          debugLogger.warn("Attachment stream hook cleanup failed.");
        }
      }
      this.inputBytes = 0;
      this.outputBytes = 0;
    }
  }
}
