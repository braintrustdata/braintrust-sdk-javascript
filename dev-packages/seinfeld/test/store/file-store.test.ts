import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Cassette } from "../../src/cassette";
import { CassetteFormatError, CassetteVersionError } from "../../src/errors";
import { createJsonFileStore } from "../../src/store";

const makeCassette = (overrides: Partial<Cassette> = {}): Cassette => ({
  version: 1,
  meta: {
    createdAt: "2026-04-29T12:00:00.000Z",
    seinfeldVersion: "0.1.0",
  },
  entries: [
    {
      id: "e1",
      matchKey: "GET example.com/",
      callIndex: 0,
      recordedAt: "2026-04-29T12:00:00.000Z",
      request: {
        method: "GET",
        url: "https://example.com/",
        headers: { accept: "application/json" },
        body: { kind: "empty" },
      },
      response: {
        status: 200,
        headers: { "content-type": "application/json" },
        body: { kind: "json", value: { ok: true } },
      },
    },
  ],
  ...overrides,
});

describe("createJsonFileStore", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "seinfeld-file-store-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns null when the cassette file does not exist", async () => {
    const store = createJsonFileStore({ rootDir: dir });
    expect(await store.load("missing")).toBeNull();
  });

  it("round-trips a cassette through save/load", async () => {
    const store = createJsonFileStore({ rootDir: dir });
    const cassette = makeCassette();
    await store.save("demo", cassette);
    const loaded = await store.load("demo");
    expect(loaded).toEqual(cassette);
  });

  it("writes pretty-printed JSON by default with a trailing newline", async () => {
    const store = createJsonFileStore({ rootDir: dir });
    await store.save("demo", makeCassette());
    const raw = await readFile(join(dir, "demo.cassette.json"), "utf8");
    expect(raw).toMatch(/^\{\n {2}"version": 1/);
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("writes compact JSON when pretty=false", async () => {
    const store = createJsonFileStore({ rootDir: dir, pretty: false });
    await store.save("demo", makeCassette());
    const raw = await readFile(join(dir, "demo.cassette.json"), "utf8");
    expect(raw.startsWith('{"version":1')).toBe(true);
    expect(raw.endsWith("\n")).toBe(false);
  });

  it("honors a custom file extension", async () => {
    const store = createJsonFileStore({ rootDir: dir, extension: ".json" });
    await store.save("demo", makeCassette());
    const raw = await readFile(join(dir, "demo.json"), "utf8");
    expect(JSON.parse(raw)).toMatchObject({ version: 1 });
  });

  it("creates nested directories from cassette names", async () => {
    const store = createJsonFileStore({ rootDir: dir });
    await store.save("agent/outer/scenario-1", makeCassette());
    const loaded = await store.load("agent/outer/scenario-1");
    expect(loaded).not.toBeNull();
  });

  it("overwrites existing cassettes on save", async () => {
    const store = createJsonFileStore({ rootDir: dir });
    await store.save("demo", makeCassette({ entries: [] }));
    await store.save("demo", makeCassette());
    const loaded = await store.load("demo");
    expect(loaded?.entries.length).toBe(1);
  });

  it("throws CassetteFormatError on invalid JSON", async () => {
    const store = createJsonFileStore({ rootDir: dir });
    await writeFile(join(dir, "broken.cassette.json"), "{not json", "utf8");
    await expect(store.load("broken")).rejects.toBeInstanceOf(
      CassetteFormatError,
    );
  });

  it("throws CassetteFormatError on schema violations", async () => {
    const store = createJsonFileStore({ rootDir: dir });
    await writeFile(
      join(dir, "badschema.cassette.json"),
      JSON.stringify({ version: 1, entries: "not an array" }),
      "utf8",
    );
    await expect(store.load("badschema")).rejects.toBeInstanceOf(
      CassetteFormatError,
    );
  });

  it("throws CassetteVersionError when version is newer than supported", async () => {
    const store = createJsonFileStore({ rootDir: dir });
    await writeFile(
      join(dir, "newer.cassette.json"),
      JSON.stringify({ version: 99, entries: [] }),
      "utf8",
    );
    await expect(store.load("newer")).rejects.toBeInstanceOf(
      CassetteVersionError,
    );
  });

  describe("blob storage", () => {
    it("round-trips blob bytes through saveBlob/loadBlob", async () => {
      const store = createJsonFileStore({ rootDir: dir });
      const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
      const path = await store.saveBlob!("demo", bytes);
      const loaded = await store.loadBlob!("demo", path);
      expect(loaded).toEqual(bytes);
    });

    it("saveBlob returns a path relative to the cassette directory", async () => {
      const store = createJsonFileStore({ rootDir: dir });
      const bytes = new Uint8Array([1, 2, 3]);
      const path = await store.saveBlob!("demo", bytes);
      // Must not be absolute
      expect(path.startsWith("/")).toBe(false);
      // Must contain the sha256 filename
      expect(path).toMatch(/[0-9a-f]{64}\.bin$/);
    });

    it("deduplicates identical blobs within a cassette", async () => {
      const store = createJsonFileStore({ rootDir: dir });
      const bytes = new Uint8Array([9, 8, 7]);
      const path1 = await store.saveBlob!("demo", bytes);
      const path2 = await store.saveBlob!("demo", bytes);
      expect(path1).toBe(path2);
    });

    it("creates a sidecar blobs directory beside the cassette file", async () => {
      const store = createJsonFileStore({ rootDir: dir });
      const bytes = new Uint8Array([1]);
      const path = await store.saveBlob!("demo", bytes);
      const blobFile = join(dir, path);
      await expect(access(blobFile)).resolves.toBeUndefined();
    });

    it("creates sidecar dir alongside nested cassette paths", async () => {
      const store = createJsonFileStore({ rootDir: dir });
      const bytes = new Uint8Array([1, 2]);
      const path = await store.saveBlob!("agent/outer", bytes);
      const blobFile = join(dir, "agent", path);
      await expect(access(blobFile)).resolves.toBeUndefined();
    });

    it("rejects path traversal attempts in loadBlob", async () => {
      const store = createJsonFileStore({ rootDir: dir });
      await expect(
        store.loadBlob!("demo", "../../../etc/passwd"),
      ).rejects.toThrow();
    });

    it("rejects absolute paths in loadBlob", async () => {
      const store = createJsonFileStore({ rootDir: dir });
      await expect(store.loadBlob!("demo", "/etc/passwd")).rejects.toThrow();
    });
  });
});
