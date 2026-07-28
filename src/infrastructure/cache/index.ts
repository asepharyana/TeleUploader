/**
 * Represents an entry in the cache with a value and expiration timestamp.
 * @template T - The type of the cached value.
 */
interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * A generic in-memory cache with configurable TTL (time-to-live) support.
 *
 * Provides simple get/set/delete operations with automatic expiration.
 * Expired entries are lazily evicted on read and can be proactively cleaned up
 * via the {@link cleanup} method.
 *
 * @template T - The type of values stored in the cache.
 */
class Cache<T> {
  private store = new Map<string, CacheEntry<T>>();
  private ttlMs: number;

  /**
   * Creates a new cache instance.
   * @param ttlSeconds - Default TTL in seconds for cached entries (default 3600).
   */
  constructor(ttlSeconds: number = 3600) {
    this.ttlMs = ttlSeconds * 1000;
  }

  /**
   * Stores a value in the cache under the given key.
   * @param key - The cache key.
   * @param value - The value to cache.
   */
  set(key: string, value: T): void {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  /**
   * Retrieves a value from the cache by key.
   * Returns `null` if the key does not exist or the entry has expired.
   * Expired entries are automatically deleted on access.
   * @param key - The cache key.
   * @returns The cached value, or `null` if not found or expired.
   */
  get(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }

    return entry.value;
  }

  /**
   * Checks whether a key exists in the cache and has not expired.
   * @param key - The cache key.
   * @returns `true` if the key exists and is still valid, `false` otherwise.
   */
  has(key: string): boolean {
    return this.get(key) !== null;
  }

  /**
   * Deletes a key from the cache.
   * @param key - The cache key to remove.
   */
  delete(key: string): void {
    this.store.delete(key);
  }

  /**
   * Clears all entries from the cache.
   */
  clear(): void {
    this.store.clear();
  }

  /**
   * Returns the total number of entries currently in the cache (including expired ones).
   * @returns The number of entries in the internal store.
   */
  size(): number {
    return this.store.size;
  }

  /**
   * Removes all expired entries from the cache.
   * @returns The number of entries removed.
   */
  cleanup(): number {
    let removed = 0;
    const now = Date.now();

    for (const [key, entry] of this.store.entries()) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
        removed++;
      }
    }

    return removed;
  }
}

/**
 * Metadata shape stored in the file info cache.
 */
interface FileInfoCacheValue {
  file_size: number;
  mime_type: string;
  file_path: string;
  bot_token: string;
}

/**
 * Singleton cache for file information with a 1-hour TTL.
 * Used to store metadata about files previously uploaded to Telegram.
 */
export const fileInfoCache = new Cache<FileInfoCacheValue>(3600);

export { Cache };
