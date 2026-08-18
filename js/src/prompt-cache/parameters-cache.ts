import { RemoteEvalParameters } from "../logger";
import { LRUCache } from "../lru-cache";
import { DiskCache } from "./disk-cache";

interface ParametersKey {
  slug?: string;
  version?: string;
  projectId?: string;
  projectName?: string;
  id?: string;
}

function createCacheKey(key: ParametersKey, namespace?: string): string {
  let cacheKey: string;
  if (key.id) {
    cacheKey = `parameters:id:${key.id}`;
  } else {
    const prefix = key.projectId ?? key.projectName;
    if (!prefix) {
      throw new Error("Either projectId or projectName must be provided");
    }
    if (!key.slug) {
      throw new Error("Slug must be provided when not using ID");
    }
    cacheKey = `parameters:${prefix}:${key.slug}:${key.version ?? "latest"}`;
  }
  return namespace === undefined
    ? cacheKey
    : `${namespace.length}:${namespace}:${cacheKey}`;
}

export type ParametersMemoryCacheEntry = {
  value: RemoteEvalParameters;
  resolvedOrgIdentity?: string;
};

export type ParametersDiskCacheEntry = {
  value: ReturnType<RemoteEvalParameters["_internalSerializeForCache"]>;
  resolvedOrgIdentity?: string;
};

export class ParametersCache {
  private readonly memoryCache?: LRUCache<string, ParametersMemoryCacheEntry>;
  private readonly diskCache?: DiskCache<ParametersDiskCacheEntry>;
  private readonly namespace?: string;
  private readonly expectedResolvedOrgIdentity?: string;

  constructor(options: {
    memoryCache?: LRUCache<string, ParametersMemoryCacheEntry>;
    diskCache?: DiskCache<ParametersDiskCacheEntry>;
    namespace?: string;
    expectedResolvedOrgIdentity?: string;
  }) {
    this.memoryCache = options.memoryCache;
    this.diskCache = options.diskCache;
    this.namespace = options.namespace;
    this.expectedResolvedOrgIdentity = options.expectedResolvedOrgIdentity;
  }

  withNamespace(
    namespace: string,
    expectedResolvedOrgIdentity?: string,
  ): ParametersCache {
    return new ParametersCache({
      memoryCache: this.memoryCache,
      diskCache: this.diskCache,
      namespace,
      expectedResolvedOrgIdentity,
    });
  }

  async get(key: ParametersKey): Promise<RemoteEvalParameters | undefined> {
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
      const diskParameters = new RemoteEvalParameters(diskEntry.value.metadata);
      this.memoryCache?.set(cacheKey, {
        value: diskParameters,
        resolvedOrgIdentity: diskEntry.resolvedOrgIdentity,
      });
      return diskParameters;
    }

    return undefined;
  }

  async set(key: ParametersKey, value: RemoteEvalParameters): Promise<void> {
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
