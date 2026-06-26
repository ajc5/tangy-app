/**
 * HTTP Client — uses TangyCache (Capacitor plugin) for native HTTP on Android,
 * which routes through OkHttp + CacheInterceptor for automatic disk caching.
 * Falls back to standard fetch() on web or when TangyCache fails.
 * Login (POST) always goes through normal fetch() for reliability.
 */

const httpClient = (() => {
  function getTangyCache() {
    try {
      if (window.Capacitor?.Plugins?.TangyCache) {
        return window.Capacitor.Plugins.TangyCache;
      }
    } catch (e) { /* not available */ }
    return null;
  }

  async function request(url, { method = 'GET', headers = {}, body } = {}) {
    const tangyCache = getTangyCache();
    const isNative = window.Capacitor?.isNativePlatform?.();

    // Use TangyCache plugin for GET on native (cached OkHttp)
    if (tangyCache && isNative && method === 'GET') {
      try {
        const result = await tangyCache.fetch({ url, method, headers: headers || {} });
        console.log('[HTTP] TangyCache:', method, url, result.status);
        const respBody = result.body || '';
        let parsedJson = null;
        try { parsedJson = JSON.parse(respBody); } catch (e) { /* not JSON */ }
        return {
          ok: result.ok,
          status: result.status,
          async json() { return parsedJson || JSON.parse(respBody); },
          async text() { return respBody; },
          headers: { get(name) { return result.contentType || null; } }
        };
      } catch (err) {
        console.warn('[HTTP] TangyCache failed, fallback:', err.message);
      }
    }

    // Direct fetch for POST/login or fallback
    console.log('[HTTP] Direct:', method, url);
    const fetchOptions = { method, headers };
    if (body) fetchOptions.body = body;
    return fetch(url, fetchOptions);
  }

  return {
    request,
    async get(url, headers = {}) { return request(url, { method: 'GET', headers }); },
    async post(url, body, headers = {}) { return request(url, { method: 'POST', headers, body }); },
    async put(url, body, headers = {}) { return request(url, { method: 'PUT', headers, body }); },
    async delete(url, headers = {}) { return request(url, { method: 'DELETE', headers }); },
    RESPECT_PROXY: null,

    async isRespectProxyAvailable() {
      // Keep for compatibility, but TangyCache is the primary caching path
      window.__respectProxyAvailable = false;
      return false;
    },
  };
})();
