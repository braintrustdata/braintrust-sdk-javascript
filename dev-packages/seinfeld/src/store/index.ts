import type { CassetteFile } from "../cassette";

/**
 * Persistence interface for cassettes.
 *
 * The default implementation is `createJsonFileStore`. Pluggable so users can
 * back cassettes by S3, in-memory maps (for testing the library itself), or
 * any other storage they prefer.
 *
 * Implementations should:
 * - Treat `name` as a logical identifier; converting it to filesystem paths
 *   (or remote keys) is the store's responsibility.
 * - Return `null` from `load` when the cassette doesn't exist (NOT throw).
 * - Always overwrite on `save` — seinfeld's `record` mode is full-overwrite.
 */
export interface CassetteStore {
  load(name: string): Promise<CassetteFile | null>;
  save(name: string, cassette: CassetteFile): Promise<void>;
  /** Optional. List all cassette names known to the store. */
  list?(): Promise<string[]>;
  /**
   * Optional. Persist a binary blob alongside a cassette and return a path
   * string (relative to the cassette file's directory) to embed in the
   * cassette's `binary` body payload. Identical bytes for the same cassette
   * may be deduplicated.
   *
   * Callers guarantee that `saveBlob` is called before `save` for any blob
   * referenced in the cassette so that readers always find the blob present.
   *
   * Stores that do not implement this method cannot record or replay cassettes
   * containing `binary` body payloads.
   */
  saveBlob?(name: string, bytes: Uint8Array): Promise<string>;
  /**
   * Optional. Load a binary blob previously saved alongside a cassette. The
   * `path` is the string embedded in the cassette's `binary` body payload —
   * the same value returned by `saveBlob`.
   */
  loadBlob?(name: string, path: string): Promise<Uint8Array>;
  /**
   * Optional. Delete a cassette and all of its associated blob sidecar files.
   */
  delete?(name: string): Promise<void>;
}

export { createJsonFileStore } from "./file-store";
export type { JsonFileStoreOptions } from "./file-store";
export { createMemoryStore } from "./memory-store";
