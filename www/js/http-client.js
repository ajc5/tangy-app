/**
 * HTTP Client - uses Capacitor native HTTP plugin to avoid CORS issues.
 * On native platforms (Android/iOS), requests go through the native HTTP stack.
 * In a browser context, falls back to the standard fetch API.
 *
 * For cache operations, see cache-service.js (Respect libcache proxy).
 */

const httpClient = (() => {
  // Respect app local cache proxy base URL
  const RESPECT_PROXY = 'http://localhost:4242';

  /**
   * Check if we are running inside a Capacitor native WebView.
   */
  function isNative() {
    try {
      return !!(
        window.Capacitor &&
        window.Capacitor.isNativePlatform &&
        window.Capacitor.isNativePlatform()
      );
    } catch (e) {
      return false;
    }
  }

  /**
   * Get the CapacitorHttp plugin instance from the Capacitor bridge.
   * Returns null if not available (e.g. running in a plain browser).
   */
  function getCapacitorHttp() {
    try {
      if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp) {
        return window.Capacitor.Plugins.CapacitorHttp;
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Make an HTTP request directly to the target server.
   * Cache interception is handled at the OS level by the Respect app
   * (no explicit proxy routing — Respect uses OkHttp interceptors
   * which apply to the system HTTP stack).
   *
   * @param {string} url
   * @param {object} [options]
   * @param {string} [options.method='GET']
   * @param {object} [options.headers={}]
   * @param {string} [options.body] - JSON string body for POST/PUT etc.
   * @returns {Promise<{ok: boolean, status: number, json: () => Promise<object>, text: () => Promise<string>}>}
   */
  async function request(url, { method = 'GET', headers = {}, body } = {}) {
    const nativeHttp = getCapacitorHttp();

    if (nativeHttp) {
      // ---- Native path: uses the platform HTTP stack, no CORS ----
      console.log('[HTTP] Using Capacitor native HTTP for:', method, url);
      try {
        const result = await nativeHttp.request({
          url,
          method,
          headers,
          data: body,
          responseType: 'json',
          connectTimeout: 30000,
          readTimeout: 30000,
        });

        return {
          ok: result.status >= 200 && result.status < 300,
          status: result.status,
          async json() {
            return result.data;
          },
          async text() {
            return typeof result.data === 'string'
              ? result.data
              : JSON.stringify(result.data);
          },
        };
      } catch (err) {
        console.warn('[HTTP] Native request failed, falling back to fetch:', err.message);
        // Fall through to fetch fallback
      }
    }

    // ---- Web/fallback path: standard fetch ----
    console.log('[HTTP] Using fetch for:', method, url);
    const fetchOptions = { method, headers };
    if (body) {
      fetchOptions.body = body;
    }
    return fetch(url, fetchOptions);
  }

  // Expose helper shortcuts
  return {
    request,

    async get(url, headers = {}) {
      return request(url, { method: 'GET', headers });
    },

    async post(url, body, headers = {}) {
      return request(url, { method: 'POST', headers, body });
    },

    async put(url, body, headers = {}) {
      return request(url, { method: 'PUT', headers, body });
    },

    async delete(url, headers = {}) {
      return request(url, { method: 'DELETE', headers });
    },

    RESPECT_PROXY,
  };
})();
