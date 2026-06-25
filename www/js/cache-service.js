/**
 * Cache Service — communicates with the Respect app's local libcache proxy
 * for offline caching and data syncing.
 *
 * The Respect app runs on the same device and provides:
 *   - Transparent HTTP caching via a local proxy (port 4242)
 *   - Retention/pinning of URLs for offline use
 *   - Distributed peer-to-peer cache discovery (DNS-SD)
 *
 * This service delegates store/retrieve/pin operations to the Respect proxy.
 */
class CacheService {
  constructor() {
    this._ready = false;
    this._proxyAvailable = false;
    this._memFallback = new Map();
  }

  async init() {
    if (this._ready) return;
    this._ready = true;

    try {
      this._proxyAvailable = await httpClient.isRespectProxyAvailable();
      if (this._proxyAvailable) {
        console.log('[CacheService] Respect proxy available at', httpClient.RESPECT_PROXY);
      } else {
        console.warn('[CacheService] Respect proxy not available — offline cache disabled');
      }
    } catch (e) {
      this._proxyAvailable = false;
    }
  }

  /**
   * Store is handled transparently by the Respect proxy when requests
   * are made through it. No explicit store needed.
   */
  async store() { /* no-op: Respect proxy caches automatically */ }

  /**
   * Retrieve a cached response from the Respect proxy's dcache endpoint.
   * Returns null if not cached or proxy unavailable.
   */
  async retrieve(url) {
    await this.init();
    if (!this._proxyAvailable) return null;

    try {
      const resp = await fetch(
        `${httpClient.RESPECT_PROXY}/dcache?url=${encodeURIComponent(url)}`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (!resp.ok) return null;

      const body = await resp.text();
      const mimeType = resp.headers.get('Content-Type') || 'application/octet-stream';
      return { body, mimeType, headers: {} };
    } catch (e) {
      console.warn('[CacheService] retrieve failed:', e.message);
      return null;
    }
  }

  /**
   * Check if a URL is cached via the Respect proxy.
   */
  async isCached(url) {
    await this.init();
    if (!this._proxyAvailable) return false;

    try {
      const resp = await fetch(
        `${httpClient.RESPECT_PROXY}/dcache?url=${encodeURIComponent(url)}`,
        { signal: AbortSignal.timeout(3000) }
      );
      return resp.ok;
    } catch (e) {
      return false;
    }
  }

  /**
   * Pin URLs for offline use.
   * Makes GET requests so the Respect proxy (or OS-level interceptor)
   * caches the responses and adds retention locks.
   */
  async downloadAndRetain(urls) {
    await this.init();
    const jobId = `respect-pin-${Date.now()}`;
    const results = { jobId, cached: 0, failed: 0, urls: [] };

    for (const { url, remark } of urls) {
      try {
        let resp;
        if (this._proxyAvailable) {
          // Route through Respect proxy so its OkHttp interceptor caches the response
          resp = await fetch(
            `${httpClient.RESPECT_PROXY}/proxy?url=${encodeURIComponent(url)}`,
            { headers: { 'Authorization': localStorage.getItem('token') || '' } }
          );
        } else {
          // Direct request — Respect may intercept at OS level if installed
          resp = await httpClient.get(url, {
            'Authorization': localStorage.getItem('token'),
          });
        }

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

  async release() { /* Respect handles eviction automatically */ }

  async getStats() {
    return { entryCount: 0, totalSizeBytes: 0, sizeLimitBytes: 0 };
  }

  async clear() { /* Respect manages its own cache */ }
}

// Singleton instance
const cacheService = new CacheService();
