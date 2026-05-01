import type { CassetteFile } from "../cassette";
import type { CassetteStore } from "./index";
import { createHash } from "node:crypto";

/**
 * In-memory cassette store. Useful for testing the library itself and for
 * tests where you want to keep cassette state purely ephemeral.
 *
 * Stores cassettes by name in a `Map`. `save` deep-clones via `structuredClone`
 * so callers can mutate their cassette objects without affecting stored copies.
 *
 * Binary blobs are stored in a parallel map keyed by cassette name and the
 * relative path returned by `saveBlob`. The path format mirrors what the file
 * store produces (`blobs/<sha256>.bin`) so cassettes round-trip between store
 * implementations without rewriting paths.
 */
export function createMemoryStore(
  initial?: Record<string, CassetteFile>,
): CassetteStore {
  const cassettes = new Map<string, CassetteFile>();
  const blobs = new Map<string, Map<string, Uint8Array>>();

  if (initial) {
    for (const [name, cassette] of Object.entries(initial)) {
      cassettes.set(name, structuredClone(cassette));
    }
  }

  return {
    load(name) {
      const found = cassettes.get(name);
      return Promise.resolve(found ? structuredClone(found) : null);
    },

    save(name, cassette) {
      cassettes.set(name, structuredClone(cassette));
      return Promise.resolve();
    },

    list() {
      return Promise.resolve([...cassettes.keys()].sort());
    },

    saveBlob(name, bytes) {
      const hash = createHash("sha256").update(bytes).digest("hex");
      const path = `blobs/${hash}.bin`;
      let nameBlobs = blobs.get(name);
      if (!nameBlobs) {
        nameBlobs = new Map();
        blobs.set(name, nameBlobs);
      }
      nameBlobs.set(path, new Uint8Array(bytes));
      return Promise.resolve(path);
    },

    loadBlob(name, path) {
      const blob = blobs.get(name)?.get(path);
      if (!blob) {
        return Promise.reject(
          new Error(`Blob not found for cassette "${name}": ${path}`),
        );
      }
      return Promise.resolve(new Uint8Array(blob));
    },
  };
}
