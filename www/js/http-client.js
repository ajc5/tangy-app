/**
 * HTTP Client — native HTTP on mobile, bypassing CORS.
 *
 * Priority on native platforms:
 *   1. TangyCache plugin (Android) — GET is cached to disk via OkHttp +
 *      CacheInterceptor (served offline); non-GET (login POST, form
 *      submissions, etc.) goes through the native OkHttp stack untouched
 *      and is never cached.
 *   2. CapacitorHttp (built-in Capacitor native HTTP) — used when TangyCache
 *      is unavailable (e.g. iOS, or plugin not registered). No CORS.
 *   Last resort: standard fetch() (web/browser context only).
 *
 * Caching is preserved: GET requests that go through TangyCache are still
 * cached to disk and served offline; non-GET requests are never cached.
 */

const httpClient = (() => {
  function isNative() {
    try {
      return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
    } catch (e) {
      return false;
    }
  }

  function getTangyCache() {
    try {
      if (window.Capacitor?.Plugins?.TangyCache) {
        return window.Capacitor.Plugins.TangyCache;
      }
    } catch (e) { /* not available */ }
    return null;
  }

  function getCapacitorHttp() {
    try {
      if (window.Capacitor?.Plugins?.CapacitorHttp) {
        return window.Capacitor.Plugins.CapacitorHttp;
      }
    } catch (e) { /* not available */ }
    return null;
  }

  // Build a fetch-like Response from the TangyCache plugin result.
  function wrapTangyCacheResponse(result) {
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
  }

  // CapacitorHttp returns parsed `data` plus a header map.
  function wrapCapacitorHttpResponse(result) {
    const ok = result.status >= 200 && result.status < 300;
    const text = typeof result.data === 'string'
      ? result.data
      : JSON.stringify(result.data);
    return {
      ok,
      status: result.status,
      async json() {
        if (typeof result.data === 'object' && result.data !== null) return result.data;
        return JSON.parse(text);
      },
      async text() { return text; },
      headers: {
        get(name) {
          if (!result.headers) return null;
          return result.headers[name] || result.headers[name.toLowerCase()] || null;
        }
      }
    };
  }

  // Build a descriptive error when a request fails end-to-end, so the UI
  // never shows the browser's generic "Failed to fetch".
  function httpError(url, method, cause) {
    const detail = cause && cause.message ? cause.message : String(cause);
    const err = new Error(`${method} ${url} — ${detail}`);
    err.url = url;
    err.method = method;
    err.cause = cause;
    return err;
  }

  async function request(url, { method = 'GET', headers = {}, body } = {}) {
    const native = isNative();
    const tangyCache = getTangyCache();
    const capacitorHttp = getCapacitorHttp();
    let lastErr = null;

    // 1. TangyCache (Android) — GET cached via OkHttp, non-GET native.
    if (native && tangyCache && tangyCache.fetch) {
      try {
        const result = await tangyCache.fetch({
          url,
          method,
          headers: headers || {},
          ...(body !== undefined ? { body } : {})
        });
        console.log('[HTTP] TangyCache:', method, url, result.status);
        return wrapTangyCacheResponse(result);
      } catch (err) {
        lastErr = err;
        console.warn('[HTTP] TangyCache failed, fallback:', err.message);
      }
    }

    // 2. CapacitorHttp (native, no CORS) — iOS / fallback.
    if (native && capacitorHttp && capacitorHttp.request) {
      try {
        const result = await capacitorHttp.request({
          url,
          method,
          headers: headers || {},
          connectTimeout: 30000,
          readTimeout: 30000,
          ...(body !== undefined && method !== 'GET' && method !== 'HEAD'
            ? { data: body }
            : {})
        });
        console.log('[HTTP] CapacitorHttp:', method, url, result.status);
        return wrapCapacitorHttpResponse(result);
      } catch (err) {
        lastErr = err;
        console.warn('[HTTP] CapacitorHttp failed, fallback:', err.message);
      }
    }

    // 3. Web / last resort: standard fetch.
    console.log('[HTTP] Direct:', method, url);
    const fetchOptions = { method, headers };
    if (body) fetchOptions.body = body;
    try {
      return await fetch(url, fetchOptions);
    } catch (err) {
      lastErr = err;
    }

    // Every transport failed — surface a useful message instead of the
    // browser's generic "Failed to fetch".
    throw httpError(url, method, lastErr);
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
