import { Prompt } from "../logger";
import { LRUCache } from "../lru-cache";
import { DiskCache } from "./disk-cache";

/**
 * Identifies a prompt in the cache using either project ID or project name along with the slug.
 */
export interface PromptKey {
  /**
   * The slug identifier for the prompt within its project.
   */
  slug?: string;

  /**
   * The version of the prompt.
   */
  version?: string;

  /**
   * The ID of the project containing the prompt.
   * Either projectId or projectName must be provided.
   */
  projectId?: string;

  /**
   * The name of the project containing the prompt.
   * Either projectId or projectName must be provided.
   */
  projectName?: string;

  /**
   * The ID of a specific prompt. If provided, slug and project parameters are ignored.
   */
  id?: string;
}

/**
 * Creates a unique cache key from prompt key.
 * @param key - The prompt key to convert into a cache key.
 * @returns A string that uniquely identifies the prompt in the cache.
 * @throws {Error} If neither projectId nor projectName is provided (when not using id).
 */
function createCacheKey(key: PromptKey): string {
  if (key.id) {
    // When caching by ID, we don't need project or slug
    return `id:${key.id}`;
  }

  const prefix = key.projectId ?? key.projectName;
  if (!prefix) {
    throw new Error("Either projectId or projectName must be provided");
  }
  if (!key.slug) {
    throw new Error("Slug must be provided when not using ID");
  }
  return `${prefix}:${key.slug}:${key.version ?? "latest"}`;
}

/**
 * A configurable cache for Braintrust prompts with optional in-memory and filesystem storage.
 *
 * This cache can use either layer independently, both layers together, or no layers.
 */
export class PromptCache {
  private readonly memoryCache?: LRUCache<string, Prompt>;
  private readonly diskCache?: DiskCache<Prompt>;

  constructor(options: {
    memoryCache?: LRUCache<string, Prompt>;
    diskCache?: DiskCache<Prompt>;
  }) {
    this.memoryCache = options.memoryCache;
    this.diskCache = options.diskCache;
  }

  /**
   * Retrieves a prompt from the cache.
   * First checks the in-memory LRU cache, then falls back to checking the disk cache if available.
   */
  async get(key: PromptKey): Promise<Prompt | undefined> {
    const cacheKey = createCacheKey(key);

    // First check memory cache.
    if (this.memoryCache) {
      const memoryPrompt = this.memoryCache.get(cacheKey);
      if (memoryPrompt !== undefined) {
        return memoryPrompt;
      }
    }

    // If not in memory and disk cache exists, check disk cache.
    if (this.diskCache) {
      const diskPrompt = await this.diskCache.get(cacheKey);
      if (!diskPrompt) {
        return undefined;
      }
      // Store in memory cache if available.
      this.memoryCache?.set(cacheKey, diskPrompt);
      return diskPrompt;
    }

    return undefined;
  }

  /**
   * Stores a prompt in the cache.
   * Writes to the in-memory cache and the disk cache if available.
   *
   * @param key - The key to store the value under.
   * @param value - The value to store in the cache.
   * @throws If there is an error writing to the disk cache.
   */
  async set(key: PromptKey, value: Prompt): Promise<void> {
    const cacheKey = createCacheKey(key);

    // Update memory cache if available.
    this.memoryCache?.set(cacheKey, value);

    // Update disk cache if available.
    if (this.diskCache) {
      await this.diskCache.set(cacheKey, value);
    }
  }
}
