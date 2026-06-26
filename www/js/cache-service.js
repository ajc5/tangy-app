/**
 * Cache Service — uses httpClient which routes through TangyCache (OkHttp +
 * CacheInterceptor) on native Android. All GET responses are automatically
 * cached to disk and served offline.
 */

class CacheService {
  constructor() {
    this._ready = false;
  }

  async init() {
    if (this._ready) return;
    this._ready = true;
    console.log('[CacheService] Initialized — GET requests auto-cached via TangyCache');
  }

  async store() { /* CacheInterceptor auto-stores */ }

  async retrieve(url) {
    try {
      const resp = await httpClient.get(url);
      if (resp.ok) return { body: await resp.text(), mimeType: resp.headers.get('content-type') };
    } catch (e) { /* offline or error */ }
    return null;
  }

  async isCached(url) {
    const plugin = window.Capacitor?.Plugins?.TangyCache;
    if (plugin) {
      try {
        const result = await plugin.isCached({ url });
        return result.cached;
      } catch (e) { /* fall through */ }
    }
    return false;
  }

  async downloadAndRetain(urls) {
    await this.init();
    const jobId = `pin-${Date.now()}`;
    const results = { jobId, cached: 0, failed: 0, urls: [] };

    for (const { url, remark } of urls) {
      try {
        const resp = await httpClient.get(url, {
          'Authorization': localStorage.getItem('token'),
        });
        if (resp.ok) {
          results.cached++;
          results.urls.push(url);
          console.log(`[CacheService] Pinned: ${url} (${remark || 'no remark'})`);
        } else {
          results.failed++;
        }
      } catch (e) {
        results.failed++;
        console.warn(`[CacheService] Pin failed for ${url}:`, e.message);
      }
    }
    return results;
  }

  async release() {}
  async getStats() { return { entryCount: 0, totalSizeBytes: 0, sizeLimitBytes: 0 }; }
  async clear() {}
}

// Singleton instance
const cacheService = new CacheService();
