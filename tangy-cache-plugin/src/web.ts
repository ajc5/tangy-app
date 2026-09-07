import type { TangyCachePlugin, CacheEntry, PinProgress, CacheStats, OfflineUrl } from './definitions';

/**
 * Web fallback using an in-memory store (session only).
 *
 * On native Android/iOS, the Kotlin/Swift implementations handle
 * disk-based caching via libcache. This web fallback is only used
 * in browser contexts and does NOT use the PWA Cache API, which
 * can be unpredictably wiped by the browser/OS.
 */
export class TangyCacheWeb implements TangyCachePlugin {
  private _entries = new Map<string, { body: string; mimeType: string; headers: Record<string, string> }>();

  async store(options: {
    url: string;
    mimeType: string;
    body: string;
    headers?: Record<string, string>;
  }): Promise<void> {
    this._entries.set(options.url, {
      body: options.body,
      mimeType: options.mimeType,
      headers: options.headers || {},
    });
  }

  async retrieve(options: {
    url: string;
  }): Promise<{ body: string; mimeType: string; headers: Record<string, string> } | null> {
    const entry = this._entries.get(options.url);
    if (!entry) return null;
    return { ...entry };
  }

  async isCached(options: { url: string }): Promise<{ cached: boolean }> {
    return { cached: this._entries.has(options.url) };
  }

  async evict(options: { urls: string[] }): Promise<{ removed: number }> {
    let removed = 0;
    for (const url of options.urls) {
      if (this._entries.delete(url)) removed++;
    }
    return { removed };
  }

  async downloadAndRetain(options: {
    urls: OfflineUrl[];
  }): Promise<{ jobId: string }> {
    const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    for (const entry of options.urls) {
      try {
        const response = await fetch(entry.url);
        if (response.ok) {
          const body = await response.text();
          const mimeType = response.headers.get('Content-Type') || 'application/octet-stream';
          this._entries.set(entry.url, { body, mimeType, headers: {} });
        }
      } catch (e) {
        console.warn(`[TangyCache] Failed to cache ${entry.url}:`, e);
      }
    }

    return { jobId };
  }

  async release(_options: { jobId: string }): Promise<void> {
    // In-memory store — entries evaporate on page unload; no release needed.
  }

  async getPinProgress(_options: {
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
    let totalSize = 0;
    for (const entry of this._entries.values()) {
      totalSize += entry.body.length;
    }
    return {
      stats: {
        entryCount: this._entries.size,
        totalSizeBytes: totalSize,
        sizeLimitBytes: 0,
      },
    };
  }

  async clear(): Promise<void> {
    this._entries.clear();
  }

  async setDistributedCachingEnabled(_options: {
    enabled: boolean;
  }): Promise<void> {
    console.log('[TangyCache] Distributed caching not available on web');
  }

  async fetch(options: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<{ ok: boolean; status: number; body: string; contentType: string }> {
    const method = options.method || 'GET';
    const init: RequestInit = {
      method,
      headers: options.headers || {},
    };
    if (options.body !== undefined && method !== 'GET' && method !== 'HEAD') {
      init.body = options.body;
    }
    const resp = await fetch(options.url, init);
    const body = await resp.text();
    return {
      ok: resp.ok,
      status: resp.status,
      body,
      contentType: resp.headers.get('Content-Type') || 'application/octet-stream',
    };
  }

  async openCachedWebView(_options: {
    url: string;
    showToolbar?: boolean;
    closeButtonText?: string;
    launchedFromRespect?: boolean;
    ipcPackage?: string;
  }): Promise<void> {
    // Web: open in new tab
    window.open(_options.url, '_blank');
  }

  async forwardXapiStatements(_options: {
    endpoint: string;
    auth: string;
    ipcPackage: string;
    statementsJson: string;
  }): Promise<{ ok: boolean; count: number; result: string }> {
    // Web: no RESPECT launcher IPC available. Nothing to relay.
    return { ok: false, count: 0, result: 'xAPI IPC not supported on web' };
  }
}
