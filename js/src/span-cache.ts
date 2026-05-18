/**
 * SpanCache provides a disk-based cache for span data, allowing
 * scorers to read spans without making server round-trips when possible.
 *
 * Spans are stored on disk to minimize memory usage during evaluations.
 * The cache file is automatically cleaned up when dispose() is called.
 *
 * In browser environments where filesystem access isn't available,
 * the cache becomes a no-op (all lookups return undefined).
 */

import iso from "./isomorph";
import { mergeDicts } from "../util/object_util";

// Global registry of active span caches for process exit cleanup
const activeCaches = new Set<SpanCache>();
let exitHandlersRegistered = false;

/**
 * Check if the span cache can be used (requires filesystem APIs).
 * This is called at runtime, not at module load time, to allow
 * configureNode() to set up the isomorph functions first.
 */
function canUseSpanCache(): boolean {
  return !!(
    iso.pathJoin &&
    iso.tmpdir &&
    iso.writeFileSync &&
    iso.appendFileSync &&
    iso.readFileSync &&
    iso.unlinkSync &&
    iso.openFile
  );
}

export interface CachedSpan {
  input?: unknown;
  output?: unknown;
  expected?: unknown;
  metadata?: Record<string, unknown>;
  span_id: string;
  span_parents?: string[];
  span_attributes?: {
    name?: string;
    type?: string;
    [key: string]: unknown;
  };
}

interface DiskSpanRecord {
  rootSpanId: string;
  spanId: string;
  data: CachedSpan;
}

/**
 * Disk-based cache for span data, keyed by rootSpanId.
 *
 * This cache writes spans to a temporary file to minimize memory usage.
 * It uses append-only writes and reads the full file when querying.
 *
 * In browser environments, this cache is automatically disabled and
 * all operations become no-ops.
 */
export class SpanCache {
  private cacheFilePath: string | null = null;
  private fileHandle: any | null = null; // type-erased fs.promises.FileHandle
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  // Tracks whether the cache was explicitly disabled (via constructor or disable())
  private _explicitlyDisabled: boolean;
  // Tracks whether the cache has been enabled (for evals only)
  private _enabled: boolean = false;
  // Reference count of active evals using this cache
  private _activeEvalCount: number = 0;

  // Small in-memory index tracking which rootSpanIds have data
  private rootSpanIndex: Set<string> = new Set();

  constructor(options?: { disabled?: boolean }) {
    // Track if user explicitly disabled the cache
    this._explicitlyDisabled = options?.disabled ?? false;
    // Cache is disabled by default until enable() is called (e.g., during Eval)
    // Initialization is lazy - file is created on first write
  }

  /**
   * Disable the cache at runtime. This is called automatically when
   * initFunction is used, since remote function spans won't be in the cache.
   */
  disable(): void {
    this._explicitlyDisabled = true;
  }

  /**
   * Start caching spans for use during evaluations.
   * This only starts caching if the cache wasn't permanently disabled.
   * Called by Eval() to turn on caching for the duration of the eval.
   * Uses reference counting to support parallel evals.
   */
  start(): void {
    if (!this._explicitlyDisabled) {
      this._enabled = true;
      this._activeEvalCount++;
    }
  }

  /**
   * Stop caching spans and return to the default disabled state.
   * Unlike disable(), this allows start() to work again for future evals.
   * Called after an eval completes to return to the default state.
   * Uses reference counting - only disables when all evals are complete.
   */
  stop(): void {
    this._activeEvalCount--;
    if (this._activeEvalCount <= 0) {
      this._activeEvalCount = 0;
      this._enabled = false;
    }
  }

  get disabled(): boolean {
    // Disabled if: explicitly disabled, not enabled, or platform doesn't support it
    return this._explicitlyDisabled || !this._enabled || !canUseSpanCache();
  }

  private async ensureInitialized(): Promise<void> {
    if (this.disabled) {
      return;
    }

    if (this.initialized) {
      return;
    }

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = (async () => {
      if (!iso.tmpdir || !iso.pathJoin || !iso.openFile) {
        // Filesystem not available - silently skip initialization
        return;
      }

      const tmpDir = iso.tmpdir();
      const uniqueId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      this.cacheFilePath = iso.pathJoin(
        tmpDir,
        `braintrust-span-cache-${uniqueId}.jsonl`,
      );

      // Open file for append+read
      this.fileHandle = await iso.openFile(this.cacheFilePath, "a+");
      this.initialized = true;

      // Register cleanup handler on first initialization
      this.registerExitHandler();
    })();

    return this.initPromise;
  }

  /**
   * Register a handler to clean up the temp file on process exit.
   * Uses a global registry to avoid registering multiple handlers.
   */
  private registerExitHandler(): void {
    // Add this cache to the global registry
    activeCaches.add(this);

    // Only register process handlers once globally
    if (
      typeof process !== "undefined" &&
      process.on &&
      !exitHandlersRegistered
    ) {
      exitHandlersRegistered = true;

      const cleanupAllCaches = () => {
        // Clean up all active caches
        for (const cache of activeCaches) {
          // Close file handle if open
          if (cache.fileHandle) {
            try {
              cache.fileHandle.close().catch(() => {});
              cache.fileHandle = null;
            } catch {
              // Ignore errors during exit cleanup
            }
          }

          // Delete the temp file
          if (cache.cacheFilePath && canUseSpanCache() && iso.unlinkSync) {
            try {
              iso.unlinkSync(cache.cacheFilePath);
            } catch {
              // Ignore cleanup errors - file might not exist or already deleted
            }
          }
        }
      };

      // Register for multiple exit scenarios
      process.on("exit", cleanupAllCaches);
      process.on("SIGINT", cleanupAllCaches);
      process.on("SIGTERM", cleanupAllCaches);
      process.on("beforeExit", cleanupAllCaches);
    }
  }

  // Buffer for pending writes - flushed asynchronously
  private writeBuffer: DiskSpanRecord[] = [];
  private flushScheduled = false;
  private flushPromise: Promise<void> | null = null;

  /**
   * Queue a span write for async flushing.
   * This is non-blocking - writes are buffered in memory and flushed
   * to disk on the next microtask.
   */
  queueWrite(rootSpanId: string, spanId: string, data: CachedSpan): void {
    if (this.disabled) {
      return;
    }

    const record: DiskSpanRecord = { rootSpanId, spanId, data };
    this.writeBuffer.push(record);
    this.rootSpanIndex.add(rootSpanId);

    // Schedule async flush if not already scheduled
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      this.flushPromise = this.flushWriteBuffer();
    }
  }

  /**
   * Flush the write buffer to disk asynchronously.
   * Called automatically after queueWrite, but can also be called explicitly.
   */
  async flushWriteBuffer(): Promise<void> {
    // Take a snapshot of records to flush, but DON'T clear the buffer yet.
    // Records stay in writeBuffer until disk write succeeds so getByRootSpanId can find them.
    const recordsToFlush = [...this.writeBuffer];
    this.flushScheduled = false;

    if (recordsToFlush.length === 0) {
      return;
    }

    await this.ensureInitialized();

    if (!this.fileHandle) {
      return;
    }

    const lines = recordsToFlush.map((r) => JSON.stringify(r) + "\n").join("");
    await this.fileHandle.appendFile(lines, "utf8");

    // Only now remove the flushed records from the buffer.
    // Filter out the records we just wrote (compare by reference).
    this.writeBuffer = this.writeBuffer.filter(
      (r) => !recordsToFlush.includes(r),
    );
  }

  /**
   * Wait for any pending writes to complete.
   * Call this before reading from the cache to ensure consistency.
   */
  async waitForPendingWrites(): Promise<void> {
    if (this.flushPromise) {
      await this.flushPromise;
      this.flushPromise = null;
    }
  }

  /**
   * Get all cached spans for a given rootSpanId.
   *
   * This reads the file and merges all records for the given rootSpanId.
   *
   * @param rootSpanId The root span ID to look up
   * @returns Array of cached spans, or undefined if not in cache
   */
  getByRootSpanId(rootSpanId: string): CachedSpan[] | undefined {
    if (this.disabled) {
      return undefined;
    }

    // Quick check using in-memory index
    if (!this.rootSpanIndex.has(rootSpanId)) {
      return undefined;
    }

    // Accumulate spans by spanId, merging updates
    const spanMap = new Map<string, CachedSpan>();

    // First, read from disk if initialized
    if (this.initialized && this.cacheFilePath && iso.readFileSync) {
      try {
        const content = iso.readFileSync(this.cacheFilePath, "utf8");
        const lines = content.trim().split("\n").filter(Boolean);

        for (const line of lines) {
          try {
            const record: DiskSpanRecord = JSON.parse(line);
            if (record.rootSpanId !== rootSpanId) {
              continue;
            }

            const existing = spanMap.get(record.spanId);
            if (existing) {
              mergeDicts(
                existing as unknown as Record<string, unknown>,
                record.data as unknown as Record<string, unknown>,
              );
            } else {
              spanMap.set(record.spanId, record.data);
            }
          } catch {
            // Skip malformed lines
          }
        }
      } catch {
        // Continue to check buffer even if disk read fails
      }
    }

    // Also check the in-memory write buffer for unflushed data
    for (const record of this.writeBuffer) {
      if (record.rootSpanId !== rootSpanId) {
        continue;
      }
      const existing = spanMap.get(record.spanId);
      if (existing) {
        mergeDicts(
          existing as unknown as Record<string, unknown>,
          record.data as unknown as Record<string, unknown>,
        );
      } else {
        spanMap.set(record.spanId, record.data);
      }
    }

    if (spanMap.size === 0) {
      return undefined;
    }

    return Array.from(spanMap.values());
  }

  /**
   * Check if a rootSpanId has cached data.
   */
  has(rootSpanId: string): boolean {
    if (this.disabled) {
      return false;
    }
    return this.rootSpanIndex.has(rootSpanId);
  }

  /**
   * Clear all cached spans for a given rootSpanId.
   * Note: This only removes from the index. The data remains in the file
   * but will be ignored on reads.
   */
  clear(rootSpanId: string): void {
    this.rootSpanIndex.delete(rootSpanId);
  }

  /**
   * Clear all cached data and remove the cache file.
   */
  clearAll(): void {
    this.rootSpanIndex.clear();
    this.dispose();
  }

  /**
   * Get the number of root spans currently tracked.
   */
  get size(): number {
    return this.rootSpanIndex.size;
  }

  /**
   * Clean up the cache file. Call this when the eval is complete.
   * Only performs cleanup when all active evals have completed (refcount = 0).
   */
  dispose(): void {
    // Only dispose if no active evals are using this cache
    if (this._activeEvalCount > 0) {
      return;
    }

    // Remove from global registry
    activeCaches.delete(this);

    // Clear pending writes
    this.writeBuffer = [];
    this.flushScheduled = false;
    this.flushPromise = null;

    if (this.fileHandle) {
      this.fileHandle.close().catch(() => {});
      this.fileHandle = null;
    }

    if (this.cacheFilePath && canUseSpanCache() && iso.unlinkSync) {
      try {
        iso.unlinkSync(this.cacheFilePath);
      } catch {
        // Ignore cleanup errors
      }
      this.cacheFilePath = null;
    }

    this.initialized = false;
    this.initPromise = null;
    this.rootSpanIndex.clear();
  }
}
