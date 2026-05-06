import { describe, expect, it } from "vitest";
import type { Cassette } from "../../src/cassette";
import { createMemoryStore } from "../../src/store";

const makeCassette = (matchKey = "GET example.com/"): Cassette => ({
  version: 1,
  entries: [
    {
      id: "e1",
      matchKey,
      callIndex: 0,
      recordedAt: "2026-04-29T12:00:00.000Z",
      request: {
        method: "GET",
        url: "https://example.com/",
        headers: {},
        body: { kind: "empty" },
      },
      response: {
        status: 200,
        headers: {},
        body: { kind: "text", value: "ok" },
      },
    },
  ],
});

describe("createMemoryStore", () => {
  it("returns null for unknown cassette names", async () => {
    const store = createMemoryStore();
    expect(await store.load("does-not-exist")).toBeNull();
  });

  it("round-trips a cassette through save/load", async () => {
    const store = createMemoryStore();
    const cassette = makeCassette();
    await store.save("demo", cassette);
    const loaded = await store.load("demo");
    expect(loaded).toEqual(cassette);
  });

  it("overwrites existing cassettes on save", async () => {
    const store = createMemoryStore();
    await store.save("demo", makeCassette("GET example.com/v1"));
    await store.save("demo", makeCassette("GET example.com/v2"));
    const loaded = await store.load("demo");
    expect(loaded?.entries[0]!.matchKey).toBe("GET example.com/v2");
  });

  it("isolates stored copies from caller mutations", async () => {
    const store = createMemoryStore();
    const cassette = makeCassette();
    await store.save("demo", cassette);
    cassette.entries[0]!.matchKey = "MUTATED";
    const loaded = await store.load("demo");
    expect(loaded?.entries[0]!.matchKey).toBe("GET example.com/");
  });

  it("isolates loaded copies from each other", async () => {
    const store = createMemoryStore();
    await store.save("demo", makeCassette());
    const a = await store.load("demo");
    const b = await store.load("demo");
    expect(a).not.toBe(b);
    expect(a?.entries[0]).not.toBe(b?.entries[0]);
  });

  it("lists all stored cassette names sorted", async () => {
    const store = createMemoryStore();
    await store.save("zeta", makeCassette());
    await store.save("alpha", makeCassette());
    await store.save("mu", makeCassette());
    expect(await store.list?.()).toEqual(["alpha", "mu", "zeta"]);
  });

  it("accepts an initial map of cassettes", async () => {
    const store = createMemoryStore({
      preset: makeCassette("GET preset/"),
    });
    const loaded = await store.load("preset");
    expect(loaded?.entries[0]!.matchKey).toBe("GET preset/");
  });

  describe("blob storage", () => {
    it("round-trips blob bytes through saveBlob/loadBlob", async () => {
      const store = createMemoryStore();
      const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
      const path = await store.saveBlob!("demo", bytes);
      const loaded = await store.loadBlob!("demo", path);
      expect(loaded).toEqual(bytes);
    });

    it("saveBlob returns a path containing the sha256", async () => {
      const store = createMemoryStore();
      const path = await store.saveBlob!("demo", new Uint8Array([1, 2, 3]));
      expect(path).toMatch(/[0-9a-f]{64}\.bin$/);
    });

    it("deduplicates identical blobs for the same cassette", async () => {
      const store = createMemoryStore();
      const bytes = new Uint8Array([9, 8, 7]);
      const p1 = await store.saveBlob!("demo", bytes);
      const p2 = await store.saveBlob!("demo", bytes);
      expect(p1).toBe(p2);
    });

    it("isolates blobs across cassette names", async () => {
      const store = createMemoryStore();
      const bytes = new Uint8Array([1]);
      await store.saveBlob!("cassette-a", bytes);
      await expect(
        store.loadBlob!("cassette-b", "blobs/anything.bin"),
      ).rejects.toThrow();
    });

    it("isolates loaded blob copies from stored copies", async () => {
      const store = createMemoryStore();
      const bytes = new Uint8Array([1, 2, 3]);
      const path = await store.saveBlob!("demo", bytes);
      const loaded = await store.loadBlob!("demo", path);
      loaded[0] = 99;
      const loaded2 = await store.loadBlob!("demo", path);
      expect(loaded2[0]).toBe(1);
    });

    it("throws for unknown blob paths", async () => {
      const store = createMemoryStore();
      await expect(
        store.loadBlob!("demo", "blobs/nonexistent.bin"),
      ).rejects.toThrow();
    });
  });
});
