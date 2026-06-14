/**
 * Cache Service - wraps the TangyCache Capacitor plugin for offline caching.
 * Falls back to Cache API when running in a browser / web context.
 */

class CacheService {
  constructor() {
    this._ready = false;
    this._useNative = false;
    this._cacheName = 'tangy-offline-v1';
  }

  async init() {
    if (this._ready) return;

    // Try to use the Capacitor native plugin
    try {
      const { TangyCache } = await import(
        /* webpackIgnore: true */ '../../tangy-cache-plugin/src/index.js'
      );
      this._native = TangyCache;
      this._useNative = true;
      console.log('[CacheService] Using native libcache plugin');
    } catch (e) {
      console.log('[CacheService] Native plugin not available, falling back to Cache API');
      this._useNative = false;
    }

    this._ready = true;
  }

  async _ensureWebCache() {
    if (!this._webCache) {
      this._webCache = await caches.open(this._cacheName);
    }
    return this._webCache;
  }

  /**
   * Store a response in the cache.
   */
  async store(url, mimeType, body, headers = {}) {
    if (this._useNative && this._native) {
      return this._native.store({ url, mimeType, body, headers });
    }

    // Web fallback
    const cache = await this._ensureWebCache();
    const response = new Response(body, {
      headers: { 'Content-Type': mimeType, ...headers },
      status: 200,
    });
    await cache.put(url, response);
  }

  /**
   * Retrieve a cached response.
   */
  async retrieve(url) {
    if (this._useNative && this._native) {
      return this._native.retrieve({ url });
    }

    const cache = await this._ensureWebCache();
    const response = await cache.match(url);
    if (!response) return null;

    return {
      body: await response.text(),
      mimeType: response.headers.get('Content-Type') || 'application/octet-stream',
      headers: Object.fromEntries(response.headers.entries()),
    };
  }

  /**
   * Check if a URL is cached.
   */
  async isCached(url) {
    if (this._useNative && this._native) {
      const result = await this._native.isCached({ url });
      return result.cached;
    }

    const cache = await this._ensureWebCache();
    const response = await cache.match(url);
    return !!response;
  }

  /**
   * Download and pin a set of URLs for offline use.
   */
  async downloadAndRetain(urls) {
    if (this._useNative && this._native) {
      return this._native.downloadAndRetain({ urls });
    }

    const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const cache = await this._ensureWebCache();

    for (const { url, remark } of urls) {
      try {
        const response = await fetch(url);
        if (response.ok) {
          await cache.put(url, response.clone());
        }
      } catch (e) {
        console.warn(`[CacheService] Failed to cache ${url}:`, e);
      }
    }

    // Store job metadata
    const metaKey = `__pinjob_${jobId}`;
    await cache.put(
      metaKey,
      new Response(JSON.stringify({ urls: urls.map((u) => u.url) }), {
        headers: { 'Content-Type': 'application/json' },
      })
    );

    return { jobId };
  }

  /**
   * Release previously pinned URLs.
   */
  async release(jobId) {
    if (this._useNative && this._native) {
      return this._native.release({ jobId });
    }

    const cache = await this._ensureWebCache();
    const metaKey = `__pinjob_${jobId}`;
    const metaResponse = await cache.match(metaKey);
    if (!metaResponse) return;

    const meta = await metaResponse.json();
    for (const url of meta.urls) {
      await cache.delete(url);
    }
    await cache.delete(metaKey);
  }

  /**
   * Get cache stats.
   */
  async getStats() {
    if (this._useNative && this._native) {
      const result = await this._native.getStats();
      return result.stats;
    }

    const cache = await this._ensureWebCache();
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
      entryCount: keys.length,
      totalSizeBytes: totalSize,
      sizeLimitBytes: 0,
    };
  }

  /**
   * Clear all cached data.
   */
  async clear() {
    if (this._useNative && this._native) {
      return this._native.clear();
    }

    await caches.delete(this._cacheName);
    this._webCache = null;
  }
}

// Singleton instance
const cacheService = new CacheService();
