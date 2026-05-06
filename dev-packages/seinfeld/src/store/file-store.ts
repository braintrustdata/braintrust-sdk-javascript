import { createHash, randomBytes } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { CassetteFormatError } from "../errors";
import { parseCassette } from "../format";
import type { CassetteStore } from "./index";

export interface JsonFileStoreOptions {
  /** Root directory under which cassettes are stored. */
  rootDir: string;
  /** File extension. Defaults to `.cassette.json`. */
  extension?: string;
  /** Whether to pretty-print on save. Defaults to `true`. */
  pretty?: boolean;
}

/**
 * JSON-on-disk cassette store.
 *
 * The cassette `name` is treated as a path relative to `rootDir`. Names like
 * `"agent/outer"` map to `${rootDir}/agent/outer.cassette.json` — nested
 * directories are created on save.
 *
 * Binary blob sidecars live in a directory beside the cassette file, named by
 * stripping the final file extension and appending `.blobs`. For example,
 * `agent/outer.cassette.json` → `agent/outer.cassette.blobs/<sha256>.bin`.
 * Paths embedded in cassette entries are relative to the cassette file's
 * directory, e.g. `outer.cassette.blobs/<sha256>.bin`.
 *
 * - `load` returns `null` when the file doesn't exist.
 * - `load` throws `CassetteVersionError` when the file's version is newer than
 *   the library supports, and `CassetteFormatError` on schema mismatches.
 * - `save` writes atomically via a temp file + rename. If two workers race on
 *   the same cassette, the last writer wins; no half-written files are left.
 */
export function createJsonFileStore(
  options: JsonFileStoreOptions,
): CassetteStore {
  const rootDir = resolve(options.rootDir);
  const extension = options.extension ?? ".cassette.json";
  const pretty = options.pretty ?? true;

  function pathFor(name: string): string {
    const resolved = resolve(join(rootDir, `${name}${extension}`));
    validateContainedPath(rootDir, resolved, `cassette name "${name}"`);
    return resolved;
  }

  function blobsDirFor(name: string): string {
    const cassettePath = pathFor(name);
    // Strip only the final extension (e.g. ".json") and replace with ".blobs"
    // so "outer.cassette.json" → "outer.cassette.blobs".
    const withoutExt = cassettePath.slice(0, -extname(cassettePath).length);
    return withoutExt + ".blobs";
  }

  function validateBlobPath(cassetteName: string, blobPath: string): string {
    const cassetteDir = dirname(pathFor(cassetteName));
    const resolved = resolve(cassetteDir, blobPath);
    validateContainedPath(rootDir, resolved, `blob path "${blobPath}"`);
    return resolved;
  }

  return {
    async load(name) {
      const path = pathFor(name);
      let raw: string;
      try {
        raw = await readFile(path, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return null;
        }
        throw err;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        throw new CassetteFormatError({
          cassetteName: name,
          message: `Invalid JSON: ${(err as Error).message}`,
        });
      }

      return parseCassette(parsed, name);
    },

    async save(name, cassette) {
      const path = pathFor(name);
      await mkdir(dirname(path), { recursive: true });
      const json = pretty
        ? JSON.stringify(cassette, null, 2)
        : JSON.stringify(cassette);
      const content = pretty ? json + "\n" : json;
      // Write atomically: temp file + rename so partial writes are never visible.
      const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
      await writeFile(tmp, content, "utf8");
      await rename(tmp, path);
    },

    async saveBlob(name, bytes) {
      const hash = createHash("sha256").update(bytes).digest("hex");
      const blobsDir = blobsDirFor(name);
      const blobFile = join(blobsDir, `${hash}.bin`);

      // Content-addressed: if the file already exists (same sha256), skip write.
      try {
        await stat(blobFile);
        // File exists — return the relative path without re-writing.
      } catch {
        // File doesn't exist yet; write atomically.
        await mkdir(blobsDir, { recursive: true });
        const tmp = `${blobFile}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
        await writeFile(tmp, bytes);
        await rename(tmp, blobFile);
      }

      // Return path relative to the cassette file's directory.
      const cassetteDir = dirname(pathFor(name));
      return relative(cassetteDir, blobFile);
    },

    async loadBlob(name, blobPath) {
      const fullPath = validateBlobPath(name, blobPath);
      return new Uint8Array(await readFile(fullPath));
    },

    async list() {
      let entries: string[];
      try {
        // readdir with recursive returns forward-slash paths on all platforms.
        entries = await readdir(rootDir, { recursive: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
      }
      const names: string[] = [];
      for (const entry of entries) {
        if (entry.endsWith(extension)) {
          // Strip the extension and normalize separators to produce a logical name.
          names.push(entry.slice(0, -extension.length).split(sep).join("/"));
        }
      }
      return names.sort();
    },

    async delete(name) {
      const cassettePath = pathFor(name);
      const blobsDir = blobsDirFor(name);
      await rm(cassettePath, { force: true });
      await rm(blobsDir, { recursive: true, force: true });
    },
  };
}

/**
 * Assert that `resolved` lies within `rootDir`. Uses `path.relative` so the
 * check is path-semantic rather than string-prefix-based (avoids false passes
 * on case-insensitive or unicode-normalizing filesystems for paths that happen
 * to share a prefix string but differ by case or composition).
 */
function validateContainedPath(
  rootDir: string,
  resolved: string,
  label: string,
): void {
  const rel = relative(rootDir, resolved);
  if (rel.startsWith("..") || resolve(rootDir, rel) !== resolved) {
    throw new Error(
      `Path traversal detected: ${label} resolves outside store root (${rootDir})`,
    );
  }
}
