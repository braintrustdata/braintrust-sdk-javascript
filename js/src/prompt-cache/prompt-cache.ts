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

export type PromptMemoryCacheEntry = {
  value: Prompt;
  resolvedOrgIdentity?: string;
};

export type PromptDiskCacheEntry = {
  value: ReturnType<Prompt["_internalSerializeForCache"]>;
  resolvedOrgIdentity?: string;
};

/**
 * Creates a unique cache key from prompt key.
 * @param key - The prompt key to convert into a cache key.
 * @returns A string that uniquely identifies the prompt in the cache.
 * @throws {Error} If neither projectId nor projectName is provided (when not using id).
 */
function createCacheKey(key: PromptKey, namespace?: string): string {
  let cacheKey: string;
  if (key.id) {
    // When caching by ID, we don't need project or slug
    cacheKey = `id:${key.id}`;
  } else {
    const prefix = key.projectId ?? key.projectName;
    if (!prefix) {
      throw new Error("Either projectId or projectName must be provided");
    }
    if (!key.slug) {
      throw new Error("Slug must be provided when not using ID");
    }
    cacheKey = `${prefix}:${key.slug}:${key.version ?? "latest"}`;
  }
  return namespace === undefined
    ? cacheKey
    : `${namespace.length}:${namespace}:${cacheKey}`;
}

/**
 * A configurable cache for Braintrust prompts with optional in-memory and filesystem storage.
 *
 * This cache can use either layer independently, both layers together, or no layers.
 */
export class PromptCache {
  private readonly memoryCache?: LRUCache<string, PromptMemoryCacheEntry>;
  private readonly diskCache?: DiskCache<PromptDiskCacheEntry>;
  private readonly namespace?: string;
  private readonly expectedResolvedOrgIdentity?: string;

  constructor(options: {
    memoryCache?: LRUCache<string, PromptMemoryCacheEntry>;
    diskCache?: DiskCache<PromptDiskCacheEntry>;
    namespace?: string;
    expectedResolvedOrgIdentity?: string;
  }) {
    this.memoryCache = options.memoryCache;
    this.diskCache = options.diskCache;
    this.namespace = options.namespace;
    this.expectedResolvedOrgIdentity = options.expectedResolvedOrgIdentity;
  }

  /**
   * Returns a cache view that shares the same storage layers but isolates all
   * entries under the provided namespace.
   */
  withNamespace(
    namespace: string,
    expectedResolvedOrgIdentity?: string,
  ): PromptCache {
    return new PromptCache({
      memoryCache: this.memoryCache,
      diskCache: this.diskCache,
      namespace,
      expectedResolvedOrgIdentity,
    });
  }

  /**
   * Retrieves a prompt from the cache.
   * First checks the in-memory LRU cache, then falls back to checking the disk cache if available.
   */
  async get(key: PromptKey): Promise<Prompt | undefined> {
    const cacheKey = createCacheKey(key, this.namespace);
    if (this.memoryCache) {
      const memoryEntry = this.memoryCache.get(cacheKey);
      if (
        memoryEntry !== undefined &&
        (this.expectedResolvedOrgIdentity === undefined ||
          memoryEntry.resolvedOrgIdentity === this.expectedResolvedOrgIdentity)
      ) {
        return memoryEntry.value;
      }
    }

    if (this.diskCache) {
      const diskEntry = await this.diskCache.get(cacheKey);
      if (
        !diskEntry ||
        (this.expectedResolvedOrgIdentity !== undefined &&
          diskEntry.resolvedOrgIdentity !== this.expectedResolvedOrgIdentity)
      ) {
        return undefined;
      }
      const serializedPrompt = diskEntry.value;
      const diskPrompt = new Prompt(
        serializedPrompt.metadata,
        serializedPrompt.defaults,
        serializedPrompt.noTrace,
      );
      this.memoryCache?.set(cacheKey, {
        value: diskPrompt,
        resolvedOrgIdentity: diskEntry.resolvedOrgIdentity,
      });
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
    const cacheKey = createCacheKey(key, this.namespace);
    const memoryEntry = {
      value,
      resolvedOrgIdentity: this.expectedResolvedOrgIdentity,
    };
    this.memoryCache?.set(cacheKey, memoryEntry);
    if (this.diskCache) {
      await this.diskCache.set(cacheKey, {
        value: value._internalSerializeForCache(),
        resolvedOrgIdentity: this.expectedResolvedOrgIdentity,
      });
    }
  }
}
