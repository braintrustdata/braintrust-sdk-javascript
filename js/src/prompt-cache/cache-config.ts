import { debugLogger } from "../debug-logger";
import iso from "../isomorph";
import { canUseDiskCache, DiskCache } from "./disk-cache";
import { LRUCache } from "../lru-cache";

type CacheMode = "mixed" | "memory" | "disk" | "none";

const CACHE_LOCATION_ENV_VAR = "BRAINTRUST_CACHE_LOCATION";
// Cache max values are entry counts, not byte sizes.
const DEFAULT_CACHE_MEMORY_MAX = 1 << 10; // 2^10 = 1024 entries.
const DEFAULT_CACHE_DISK_MAX = 1 << 20; // 2^20 = 1,048,576 entries.
let warnedInvalidCacheModeEnvValue = false;
let warnedUnavailableDiskCacheMode = false;

function warnInvalidCacheMode(value: string) {
  if (warnedInvalidCacheModeEnvValue) {
    return;
  }
  warnedInvalidCacheModeEnvValue = true;
  debugLogger.warn(
    `Invalid ${CACHE_LOCATION_ENV_VAR} value "${value}". Expected "mixed", "memory", "disk", or "none". Falling back to "mixed".`,
  );
}

function warnUnavailableDiskCache() {
  if (warnedUnavailableDiskCacheMode) {
    return;
  }
  warnedUnavailableDiskCacheMode = true;
  debugLogger.warn(
    `Disk cache is not supported on this platform, so ${CACHE_LOCATION_ENV_VAR}="disk" disables prompt and parameters caching.`,
  );
}

function parseCacheMode(): CacheMode {
  const value = iso.getEnv(CACHE_LOCATION_ENV_VAR);
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return "mixed";
  }
  if (
    normalized === "mixed" ||
    normalized === "memory" ||
    normalized === "disk" ||
    normalized === "none"
  ) {
    return normalized;
  }
  warnInvalidCacheMode(value ?? "");
  return "mixed";
}

function parsePositiveIntegerEnv(envVar: string, defaultValue: number): number {
  const value = Number(iso.getEnv(envVar));
  return Number.isInteger(value) && value > 0 ? value : defaultValue;
}

export function createCacheLayers<T>({
  memoryMaxEnvVar,
  diskCacheDirEnvVar,
  diskMaxEnvVar,
  getDefaultDiskCacheDir,
}: {
  memoryMaxEnvVar: string;
  diskCacheDirEnvVar: string;
  diskMaxEnvVar: string;
  getDefaultDiskCacheDir: () => string;
}): {
  memoryCache?: LRUCache<string, T>;
  diskCache?: DiskCache<T>;
} {
  const mode = parseCacheMode();
  const memoryCache =
    mode === "mixed" || mode === "memory"
      ? new LRUCache<string, T>({
          max: parsePositiveIntegerEnv(
            memoryMaxEnvVar,
            DEFAULT_CACHE_MEMORY_MAX,
          ),
        })
      : undefined;

  let diskCache: DiskCache<T> | undefined;
  if (mode === "mixed" || mode === "disk") {
    if (canUseDiskCache()) {
      diskCache = new DiskCache<T>({
        cacheDir: iso.getEnv(diskCacheDirEnvVar) ?? getDefaultDiskCacheDir(),
        max: parsePositiveIntegerEnv(diskMaxEnvVar, DEFAULT_CACHE_DISK_MAX),
      });
    } else if (mode === "disk") {
      warnUnavailableDiskCache();
    }
  }

  if (diskCache) {
    return { memoryCache, diskCache };
  }
  return { memoryCache };
}
