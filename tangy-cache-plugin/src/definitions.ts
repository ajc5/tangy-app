/// <reference types="@capacitor/core" />

declare module '@capacitor/core' {
  interface PluginRegistry {
    TangyCache: TangyCachePlugin;
  }
}

export interface CacheEntry {
  url: string;
  mimeType: string;
  sizeBytes: number;
  storedAt: number;
  lastValidated: number;
}

export interface PinProgress {
  status: 'not-pinned' | 'preparing' | 'in-progress' | 'ready' | 'failed';
  totalSize: number;
  transferred: number;
}

export interface CacheStats {
  entryCount: number;
  totalSizeBytes: number;
  sizeLimitBytes: number;
}

export interface OfflineUrl {
  url: string;
  remark?: string;
}

export interface TangyCachePlugin {
  /**
   * Cache an HTTP response for a given URL. Useful for pre-caching known content.
   */
  store(options: {
    url: string;
    mimeType: string;
    body: string;
    headers?: Record<string, string>;
  }): Promise<void>;

  /**
   * Retrieve a cached response. Returns null if not in cache.
   */
  retrieve(options: { url: string }): Promise<{
    body: string;
    mimeType: string;
    headers: Record<string, string>;
  } | null>;

  /**
   * Check if a URL is cached and ready for offline use.
   */
  isCached(options: { url: string }): Promise<{ cached: boolean }>;

  /**
   * Download and retain a set of URLs for offline use (pin them).
   * Returns a job ID that can be used to release them later.
   */
  downloadAndRetain(options: {
    urls: OfflineUrl[];
  }): Promise<{ jobId: string }>;

  /**
   * Release previously pinned URLs, allowing them to be evicted from cache.
   */
  release(options: { jobId: string }): Promise<void>;

  /**
   * Get the pin/download progress for a specific manifest or job.
   */
  getPinProgress(options: {
    manifestUrl: string;
  }): Promise<{ progress: PinProgress }>;

  /**
   * Get overall cache statistics.
   */
  getStats(): Promise<{ stats: CacheStats }>;

  /**
   * Clear the entire cache.
   */
  clear(): Promise<void>;

  /**
   * Enable or disable the distributed (peer-to-peer) cache discovery.
   */
  setDistributedCachingEnabled(options: {
    enabled: boolean;
  }): Promise<void>;
}
