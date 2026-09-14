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

  /**
   * Fetch and retain every URL so it can be served offline later.
   *
   * @param {Array<{url: string, remark?: string}>} urls
   * @param {(done: number, total: number) => void} [onProgress] Called after each URL.
   * @param {{cancelled: boolean}} [signal] Cooperative cancel flag: checked
   *   before each request, so a cancel takes effect within one request.
   */
  async downloadAndRetain(urls, onProgress, signal) {
    await this.init();
    const jobId = `pin-${Date.now()}`;
    const results = { jobId, cached: 0, failed: 0, cancelled: false, urls: [] };

    let done = 0;
    for (const { url, remark } of urls) {
      if (signal && signal.cancelled) {
        results.cancelled = true;
        console.log(`[CacheService] Cancelled after ${done}/${urls.length} URLs`);
        break;
      }
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

      // Drive determinate progress UIs. A throwing listener must never abort
      // the pin itself, so it is isolated from the loop's error handling.
      done++;
      if (typeof onProgress === 'function') {
        try {
          onProgress(done, urls.length);
        } catch (e) { /* ignore */ }
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
