import type { TangyCachePlugin, CacheEntry, PinProgress, CacheStats, OfflineUrl } from './definitions';

/**
 * Web (fallback) implementation using the Cache API.
 * On native platforms, the actual libcache is used.
 */
export class TangyCacheWeb implements TangyCachePlugin {
  private cacheName = 'tangy-cache-v1';

  private async ensureCache(): Promise<Cache> {
    return await caches.open(this.cacheName);
  }

  async store(options: {
    url: string;
    mimeType: string;
    body: string;
    headers?: Record<string, string>;
  }): Promise<void> {
    const cache = await this.ensureCache();
    const headers = new Headers({
      'Content-Type': options.mimeType,
      ...options.headers,
    });
    const response = new Response(options.body, {
      headers,
      status: 200,
    });
    await cache.put(options.url, response);
  }

  async retrieve(options: {
    url: string;
  }): Promise<{ body: string; mimeType: string; headers: Record<string, string> } | null> {
    const cache = await this.ensureCache();
    const response = await cache.match(options.url);
    if (!response) return null;

    const body = await response.text();
    const mimeType = response.headers.get('Content-Type') || 'application/octet-stream';
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return { body, mimeType, headers };
  }

  async isCached(options: { url: string }): Promise<{ cached: boolean }> {
    const cache = await this.ensureCache();
    const response = await cache.match(options.url);
    return { cached: !!response };
  }

  async downloadAndRetain(options: {
    urls: OfflineUrl[];
  }): Promise<{ jobId: string }> {
    const cache = await this.ensureCache();
    const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    for (const entry of options.urls) {
      try {
        const response = await fetch(entry.url);
        if (response.ok) {
          await cache.put(entry.url, response);
        }
      } catch (e) {
        console.warn(`[TangyCache] Failed to cache ${entry.url}:`, e);
      }
    }

    // Store job metadata
    const metaKey = `__pinjob_${jobId}`;
    const meta = new Response(
      JSON.stringify({ urls: options.urls.map((u) => u.url), createdAt: Date.now() }),
      { headers: { 'Content-Type': 'application/json' } }
    );
    await cache.put(metaKey, meta);

    return { jobId };
  }

  async release(options: { jobId: string }): Promise<void> {
    const cache = await this.ensureCache();
    const metaKey = `__pinjob_${options.jobId}`;
    const metaResponse = await cache.match(metaKey);
    if (!metaResponse) return;

    const meta = await metaResponse.json();
    for (const url of meta.urls) {
      await cache.delete(url);
    }
    await cache.delete(metaKey);
  }

  async getPinProgress(options: {
    manifestUrl: string;
  }): Promise<{ progress: PinProgress }> {
    return {
      progress: {
        status: 'not-pinned',
        totalSize: 0,
        transferred: 0,
      },
    };
  }

  async getStats(): Promise<{ stats: CacheStats }> {
    const cache = await this.ensureCache();
    const keys = await cache.keys();
    let totalSize = 0;
    for (const request of keys) {
      const response = await cache.match(request);
      if (response) {
        const body = await response.clone().text();
        totalSize += body.length;
      }
    }
    return {
      stats: {
        entryCount: keys.length,
        totalSizeBytes: totalSize,
        sizeLimitBytes: 0, // unlimited in Cache API
      },
    };
  }

  async clear(): Promise<void> {
    await caches.delete(this.cacheName);
  }

  async setDistributedCachingEnabled(options: {
    enabled: boolean;
  }): Promise<void> {
    console.log('[TangyCache] Distributed caching not available on web');
  }
}
