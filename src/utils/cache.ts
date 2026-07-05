// Simple in-memory cache with TTL support
interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

class Cache<T> {
  private store = new Map<string, CacheEntry<T>>();
  private ttlMs: number;

  constructor(ttlSeconds: number = 3600) {
    this.ttlMs = ttlSeconds * 1000;
  }

  set(key: string, value: T): void {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  get(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }

    return entry.value;
  }

  has(key: string): boolean {
    return this.get(key) !== null;
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }

  // Cleanup expired entries
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

// File info cache (1 hour TTL)
export const fileInfoCache = new Cache<{
  file_size: number;
  mime_type: string;
  file_path: string;
  bot_token: string;
}>(3600);

export { Cache };
