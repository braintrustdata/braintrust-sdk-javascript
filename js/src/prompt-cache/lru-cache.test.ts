import { describe, expect, it } from "vitest";
import { LRUCache } from "./lru-cache";

describe("LRUCache", () => {
  it("should store and retrieve values", () => {
    const cache = new LRUCache<string, number>();
    cache.set("a", 1);
    expect(cache.get("a")).toBe(1);
  });

  it("should return undefined for missing keys", () => {
    const cache = new LRUCache<string, number>();
    expect(cache.get("missing")).toBeUndefined();
  });

  it("should respect max size when specified", () => {
    const cache = new LRUCache<string, number>({ max: 2 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
  });

  it("should grow unbounded when no max size specified", () => {
    const cache = new LRUCache<number, number>();
    // Add many items.
    for (let i = 0; i < 1000; i++) {
      cache.set(i, i);
    }
    // Should keep all items.
    for (let i = 0; i < 1000; i++) {
      expect(cache.get(i)).toBe(i);
    }
  });

  it("should refresh items on get", () => {
    const cache = new LRUCache<string, number>({ max: 2 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a"); // refresh "a"
    cache.set("c", 3);
    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBe(3);
  });

  it("should update existing keys", () => {
    const cache = new LRUCache<string, number>();
    cache.set("a", 1);
    cache.set("a", 2);
    expect(cache.get("a")).toBe(2);
  });

  it("should refresh items on has", () => {
    const cache = new LRUCache<string, number>({ max: 2 });
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.has("a")).toBe(true);
    cache.set("c", 3);
    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
  });

  it("should delete and iterate over items", () => {
    const cache = new LRUCache<string, number>();
    cache.set("a", 1);
    cache.set("b", 2);

    expect([...cache]).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
    expect([...cache.keys()]).toEqual(["a", "b"]);
    expect([...cache.values()]).toEqual([1, 2]);
    expect(cache.delete("a")).toBe(true);
    expect(cache.delete("missing")).toBe(false);
    expect([...cache.entries()]).toEqual([["b", 2]]);
  });

  it("should clear all items", () => {
    const cache = new LRUCache<string, number>();
    cache.set("a", 1);
    cache.set("b", 2);
    cache.clear();
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeUndefined();
  });
});
