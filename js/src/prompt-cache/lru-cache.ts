/**
 * Options for configuring an LRUCache instance.
 */
interface LRUCacheOptions {
  /**
   * Maximum number of items to store in the cache.
   * If not specified, the cache will grow unbounded.
   */
  max?: number;
}

/**
 * A Least Recently Used (LRU) cache implementation.
 *
 * This cache maintains items in order of use, evicting the least recently used item
 * when the cache reaches its maximum size (if specified). Items are considered "used"
 * when they are either added to the cache or retrieved from it.
 *
 * If no maximum size is specified, the cache will grow unbounded.
 *
 * @template K - The type of keys stored in the cache.
 * @template V - The type of values stored in the cache.
 */
export class LRUCache<K, V> {
  private cache: Map<K, V>;
  private readonly maxSize?: number;

  constructor(options: LRUCacheOptions = {}) {
    this.cache = new Map();
    this.maxSize = options.max;
  }

  /**
   * Retrieves a value from the cache.
   * If the key exists, the item is marked as most recently used.
   *
   * @param key - The key to look up.
   * @returns The cached value if found, undefined otherwise.
   */
  get(key: K): V | undefined {
    const value = this.cache.get(key);
    if (value === undefined) {
      return undefined;
    }
    // Refresh key by moving to end of Map.
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  /**
   * Checks whether a key exists and marks it as most recently used.
   */
  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  /**
   * Stores a value in the cache.
   * If the key already exists, the value is updated and marked as most recently used.
   * If the cache is at its maximum size, the least recently used item is evicted.
   *
   * @param key - The key to store.
   * @param value - The value to store.
   */
  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.maxSize && this.cache.size >= this.maxSize) {
      // Map.keys() iterates in insertion order.
      const first = this.cache.keys().next().value;
      this.cache.delete(first);
    }
    this.cache.set(key, value);
  }

  /**
   * Removes an item from the cache.
   */
  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  /**
   * Iterates over cache entries from least to most recently used.
   */
  entries(): IterableIterator<[K, V]> {
    return this.cache.entries();
  }

  /**
   * Iterates over cache keys from least to most recently used.
   */
  keys(): IterableIterator<K> {
    return this.cache.keys();
  }

  /**
   * Iterates over cache values from least to most recently used.
   */
  values(): IterableIterator<V> {
    return this.cache.values();
  }

  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.entries();
  }

  /**
   * Removes all items from the cache.
   */
  clear(): void {
    this.cache.clear();
  }
}
