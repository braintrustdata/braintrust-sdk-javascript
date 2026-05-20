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
import { dirname, extname, join, relative, resolve } from "node:path";
import type { CassetteFile } from "../cassette";
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
      const sorted = sortKeys(cassette);
      const json = pretty
        ? JSON.stringify(sorted, null, 2)
        : JSON.stringify(sorted);
      const content = pretty ? json + "\n" : json;
      // Write atomically: temp file + rename so partial writes are never visible.
      const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
      await writeFile(tmp, content, "utf8");
      await rename(tmp, path);
      await cleanupBlobSidecars(name, cassette);
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

    async delete(name) {
      const cassettePath = pathFor(name);
      const blobsDir = blobsDirFor(name);
      await rm(cassettePath, { force: true });
      await rm(blobsDir, { recursive: true, force: true });
    },
  };

  async function cleanupBlobSidecars(
    name: string,
    cassette: CassetteFile,
  ): Promise<void> {
    const blobsDir = blobsDirFor(name);
    const referenced = new Set<string>();
    for (const blobPath of referencedBlobPaths(cassette)) {
      referenced.add(validateBlobPath(name, blobPath));
    }

    if (referenced.size === 0) {
      await rm(blobsDir, { recursive: true, force: true });
      return;
    }

    let entries: string[];
    try {
      entries = await readdir(blobsDir, { recursive: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }

    for (const entry of entries) {
      const fullPath = resolve(blobsDir, entry);
      validateContainedPath(blobsDir, fullPath, `blob sidecar "${entry}"`);
      const stats = await stat(fullPath);
      if (stats.isFile() && !referenced.has(fullPath)) {
        await rm(fullPath, { force: true });
      }
    }
  }
}

function referencedBlobPaths(cassette: CassetteFile): string[] {
  const paths: string[] = [];
  for (const entry of cassette.entries) {
    if (entry.request.body.kind === "binary") {
      paths.push(entry.request.body.path);
    }
    if (entry.response.body.kind === "binary") {
      paths.push(entry.response.body.path);
    }
  }
  return paths;
}

/** Recursively sort object keys so cassette files are deterministic across recording runs. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
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
