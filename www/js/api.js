// API utility for communicating with Tangerine server
// Uses httpClient (native Capacitor HTTP when available, fetch fallback)
// Now uses OPDS protocol for group and form discovery

/**
 * Extract group ID from an OPDS href like
 * "/opds/groups/group-740bd95c-da28-4399-9fa4-9d6a769ffe29?respectToken=..."
 */
function extractGroupId(href) {
  try {
    const path = href.split('?')[0];
    const segments = path.replace(/\/+$/, '').split('/');
    return segments[segments.length - 1];
  } catch (e) {
    return href;
  }
}

/**
 * Extract form ID from an OPDS identifier like
 * "/opds/groups/group-.../form-91e54abe-de81-41b4-a630-478605652635?respectToken=..."
 */
function extractFormId(identifier) {
  try {
    const path = identifier.split('?')[0];
    const segments = path.replace(/\/+$/, '').split('/');
    return segments[segments.length - 1];
  } catch (e) {
    return identifier;
  }
}

/**
 * Recent login tracking: saves a history of servers and usernames so users
 * can quickly reconnect. Stored in localStorage under 'recentLogins' as an
 * array of { server, username, ts } entries (most recent first, deduped, capped).
 */
const RECENT_LOGINS_KEY = 'recentLogins';
const MAX_RECENT_LOGINS = 10;

// Always-available demo login, shown in the server/user dropdowns even after
// the recent servers/usernames history is cleared.
const DEMO_SERVER = 'https://tangy.is-local.host';
const DEMO_USERNAME = 'appuser';
const DEMO_PASSWORD = 'Password1!';

function _getRecentLogins() {
  try {
    const raw = localStorage.getItem(RECENT_LOGINS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

function _saveRecentLogins(list) {
  localStorage.setItem(RECENT_LOGINS_KEY, JSON.stringify(list));
}

function _normalizeServer(server) {
  return String(server || '').replace(/\/+$/, '').toLowerCase();
}

const api = {
  baseUrl: '',

  setBaseUrl(url) {
    this.baseUrl = url.replace(/\/+$/, ''); // remove trailing slash
    localStorage.setItem('serverUrl', this.baseUrl);
  },

  getBaseUrl() {
    return this.baseUrl || localStorage.getItem('serverUrl') || '';
  },

  getRespectUrl() {
    return localStorage.getItem('respectUrl') || '';
  },

  getUsername() {
    return localStorage.getItem('username') || '';
  },

  /**
   * The demo password for the demo user (appuser) on the demo server, or null
   * for any other user/server. Used to auto-fill the login form.
   */
  getDemoPassword(username) {
    if (
      username === DEMO_USERNAME &&
      _normalizeServer(this.getBaseUrl()) === _normalizeServer(DEMO_SERVER)
    ) {
      return DEMO_PASSWORD;
    }
    return null;
  },

  /**
   * Whether the given server URL is the always-available demo server.
   */
  isDemoServer(server) {
    return !!server && _normalizeServer(server) === _normalizeServer(DEMO_SERVER);
  },

  /**
   * Record a server connection (e.g. user tapped Connect on the server screen).
   */
  recordServer(server) {
    this._addRecentLogin(server, '');
  },

  /**
   * Record a successful login for a server + username.
   */
  recordLogin(server, username) {
    this._addRecentLogin(server, username);
  },

  _addRecentLogin(server, username) {
    const normalized = server ? server.replace(/\/+$/, '') : '';
    if (!normalized) return;
    let list = _getRecentLogins();
    // Remove any prior entry for the same (server, username) pair
    list = list.filter(
      (e) => e.server !== normalized || (e.username || '') !== (username || '')
    );
    // If a real username is provided, drop the bare server-only entry
    if (username) {
      list = list.filter((e) => e.server !== normalized || e.username);
    }
    list.unshift({ server: normalized, username: username || '', ts: Date.now() });
    _saveRecentLogins(list.slice(0, MAX_RECENT_LOGINS));
  },

  /**
   * Unique servers from the recent logins list (most recent first).
   */
  getRecentServers() {
    const recent = _getRecentLogins()
      .map((e) => e.server)
      .filter(Boolean);
    // Demo server is always available (deduped), shown first as the default.
    return [DEMO_SERVER, ...recent]
      .filter((server, i, arr) =>
        arr.findIndex((s) => _normalizeServer(s) === _normalizeServer(server)) === i);
  },

  /**
   * Usernames used on a given server (most recent first, unique).
   */
  getRecentUsernames(server) {
    const target = _normalizeServer(server);
    const recent = _getRecentLogins()
      .filter((e) => _normalizeServer(e.server) === target && e.username)
      .map((e) => e.username)
      .filter((u, i, arr) => arr.indexOf(u) === i);
    // Demo username is always available for the demo server, shown first.
    if (target === _normalizeServer(DEMO_SERVER)) {
      return [DEMO_USERNAME, ...recent].filter((u, i, arr) => arr.indexOf(u) === i);
    }
    return recent;
  },

  /**
   * Clear ALL saved login data: the recent servers/usernames history plus the
   * currently stored session (server URL, username, token, respect data).
   */
  clearAllLoginData() {
    localStorage.removeItem('recentLogins');
    localStorage.removeItem('serverUrl');
    localStorage.removeItem('username');
    localStorage.removeItem('token');
    localStorage.removeItem('respectUrl');
    localStorage.removeItem('respectManifest');
  },

  /**
   * Extract the respectToken from the stored OPDS root document or URL.
   */
  _getRespectToken() {
    // First, try to get the token from the stored manifest (if already fetched)
    const manifest = localStorage.getItem('respectManifest');
    if (manifest) {
      try {
        const parsed = JSON.parse(manifest);
        // 1. Extract token from learningUnits URL
        if (parsed && parsed.learningUnits) {
          const luUrl = new URL(parsed.learningUnits, this.getBaseUrl());
          const token = luUrl.searchParams.get('respectToken');
          if (token) return token;
        }
        // 2. Extract token from links array (the groups/collection feed link)
        if (parsed && parsed.links && Array.isArray(parsed.links)) {
          const FEED_RELS = [
            'http://opds-spec.org/catalog',
            'http://opds-spec.org/collection',
            'collection'
          ];
          const catalogLink = parsed.links.find(
            l => l && l.href && FEED_RELS.includes(String(l.rel || ''))
          );
          if (catalogLink) {
            const linkUrl = new URL(catalogLink.href, this.getBaseUrl());
            const token = linkUrl.searchParams.get('respectToken');
            if (token) return token;
          }
        }
      } catch (e) {
        // Not parseable
      }
    }

    // Fallback: try to extract from respectUrl (URL string)
    const stored = localStorage.getItem('respectUrl');
    if (!stored) return '';
    try {
      const url = new URL(stored, this.getBaseUrl());
      return url.searchParams.get('respectToken') || '';
    } catch (e) {
      // Not parseable
    }
    return '';
  },

  /**
   * Resolve the learningUnits (groups) URL from the stored OPDS root document.
   * The OPDS root may store the groups URL in:
   *   1. A top-level `learningUnits` property
   *   2. A `links` entry pointing at the groups feed — servers use different
   *      rels: `http://opds-spec.org/catalog`, `collection`, or a bare href to
   *      the `/opds/groups` feed (Tangerine respect-app-manifest/v2 uses rel
   *      `collection`).
   *   3. A `navigation` entry (groups returned directly in manifest)
   * Returns the resolved URL string, or null to fall back to `/groups`.
   */
  _resolveDocLearningUnitsUrl(doc) {
    // 1. Direct learningUnits property
    if (doc && doc.learningUnits) {
      if (doc.learningUnits.startsWith('http')) {
        return doc.learningUnits;
      }
      return `${this.getBaseUrl()}${doc.learningUnits}`;
    }

    // 2. OPDS links array — find the link that points at the groups feed.
    if (doc && doc.links && Array.isArray(doc.links)) {
      const GROUPS_RELS = [
        'http://opds-spec.org/catalog',
        'http://opds-spec.org/collection',
        'http://opds-spec.org/group',
        'collection'
      ];
      const catalogLink = doc.links.find((l) => {
        if (!l || !l.href) return false;
        const rel = String(l.rel || '');
        // Skip links that obviously aren't the groups feed.
        if (rel === 'self' ||
            rel === 'https://id.openeel.org/rel/app-launch-uri' ||
            rel === 'app-launch-uri') {
          return false;
        }
        if (GROUPS_RELS.includes(rel)) return true;
        // Fallback: the href's path is the OPDS groups feed.
        try {
          const path = new URL(l.href, this.getBaseUrl()).pathname.replace(/\/+$/, '');
          if (path.endsWith('/opds/groups')) return true;
        } catch (e) {
          // Ignore unparseable hrefs.
        }
        return false;
      });
      if (catalogLink && catalogLink.href) {
        if (catalogLink.href.startsWith('http')) {
          return catalogLink.href;
        }
        return `${this.getBaseUrl()}${catalogLink.href}`;
      }
    }

    // 3. navigation directly contains groups — return stored URL so getGroups() parses it
    if (doc && doc.navigation && Array.isArray(doc.navigation)) {
      // Signal that the current URL already returns groups data
      return '__GROUPS_IN_MANIFEST__';
    }

    return null;
  },

  /**
   * True if the stored OPDS root belongs to the given server base URL.
   * A manifest cached from an earlier login or a different server must not
   * drive the UI (it can list groups/forms that no longer exist).
   */
  _manifestBelongsToServer(manifest, baseUrl) {
    if (!manifest || !baseUrl) return false;
    let baseHost = '';
    try { baseHost = new URL(baseUrl).host; } catch (e) { return false; }
    const candidates = [
      manifest.learningUnits,
      manifest.defaultLaunchUri,
      ...(Array.isArray(manifest.links) ? manifest.links.map(l => l.href) : [])
    ].filter(Boolean);
    return candidates.some(c => {
      try { return new URL(c, baseUrl).host === baseHost; } catch (e) { return false; }
    });
  },

  /**
   * Resolve the learningUnits (groups) URL from the stored respectUrl.
   */
  async _resolveLearningUnitsUrl() {
    // Check if manifest is already cached
    const manifest = localStorage.getItem('respectManifest');
    if (manifest) {
      try {
        const parsed = JSON.parse(manifest);
        // Only trust a cached manifest that belongs to the CURRENT server.
        // A stale copy from an earlier login/server must be ignored.
        if (this._manifestBelongsToServer(parsed, this.getBaseUrl())) {
          const result = this._resolveDocLearningUnitsUrl(parsed);
          if (result === '__GROUPS_IN_MANIFEST__') {
            return '__GROUPS_IN_MANIFEST__';
          }
          if (result) {
            return result;
          }
        } else {
          console.log('[API] Stored manifest is from a different server — discarding stale copy');
          localStorage.removeItem('respectManifest');
        }
      } catch (e) {
        // Not parseable — proceed to fetch
      }
    }

    // Fetch the manifest from the stored respectUrl
    const stored = localStorage.getItem('respectUrl');
    if (!stored) return null;

    try {
      console.log('[API] Fetching manifest from respectUrl:', stored);
      const response = await httpClient.get(stored, {
        'Authorization': localStorage.getItem('token')
      });
      if (response.ok) {
        const manifest = await response.json();
        console.log('[API] Manifest response:', JSON.stringify(manifest, null, 2).slice(0, 500));
        // Only trust a manifest that belongs to the CURRENT server. If the
        // stored respectUrl points at a different server than the one the shell
        // is connected to (e.g. stale after a RESPECT deep link switched
        // servers without a login), discard it rather than rendering another
        // server's groups/forms.
        if (!this._manifestBelongsToServer(manifest, this.getBaseUrl())) {
          console.warn('[API] respectUrl manifest belongs to a different server — discarding');
          localStorage.removeItem('respectManifest');
          localStorage.removeItem('respectUrl');
          return null;
        }
        // Cache the resolved OPDS root separately — don't overwrite respectUrl
        localStorage.setItem('respectManifest', JSON.stringify(manifest));

        const result = this._resolveDocLearningUnitsUrl(manifest);
        if (result === '__GROUPS_IN_MANIFEST__') {
          return '__GROUPS_IN_MANIFEST__';
        }
        return result;
      }
    } catch (e) {
      console.warn('[API] Failed to fetch manifest, falling back:', e.message);
    }

    return null;
  },

  /**
   * Log in with username/password and persist the session (token, username,
   * respectUrl). Optionally skip recording the server/username into the
   * recent-logins history — used by automated RESPECT launches where the user
   * never typed these credentials.
   *
   * @param {Object} [options]
   * @param {boolean} [options.record=true]  Record into recent logins.
   */
  async login(username, password, { record = true } = {}) {
    const url = `${this.getBaseUrl()}/login`;
    console.log('[API] POST login request to:', url);
    const response = await httpClient.post(
      url,
      JSON.stringify({ username, password }),
      { 'Content-Type': 'application/json' }
    );
    console.log('[API] POST login response status:', response.status);
    if (!response.ok) {
      const errorText = await response.text();
      console.log('[API] POST login error body:', errorText);
      throw new Error('Login failed');
    }
    const result = await response.json();
    console.log('[API] POST login response data:', JSON.stringify(result, null, 2));

    const token = (result.data && result.data.token) || result.token;
    if (token) {
      localStorage.setItem('token', token);
      localStorage.setItem('username', username);
      if (record) {
        this.recordLogin(this.getBaseUrl(), username);
      }
    }

    const respectUrlValue = (result.data && result.data.respectUrl) || result.respectUrl;
    if (respectUrlValue) {
      if (typeof respectUrlValue === 'object' && respectUrlValue !== null) {
        localStorage.setItem('respectUrl', JSON.stringify(respectUrlValue));
      } else {
        localStorage.setItem('respectUrl', respectUrlValue);
      }
    }

    // Invalidate any cached OPDS root from a previous login/server. It will
    // be re-fetched from the fresh respectUrl above, so we never show groups
    // or forms from an old server or an outdated server state.
    localStorage.removeItem('respectManifest');

    // Apply the user's language from the server (source of truth after login).
    // The server may not send it yet, but when it does we honor it — it takes
    // precedence over the manual picker choice until the next login.
    const language = (result.data && result.data.language) ||
                     result.language ||
                     (result.user && result.user.language);
    if (language && typeof I18N !== 'undefined' && I18N && I18N.applyLocale) {
      I18N.applyLocale(String(language).split('-')[0].toLowerCase());
    }

    return result;
  },

  /**
   * Establish a real Tangerine session (JWT + respectUrl) from the HTTP Basic
   * credentials supplied on a RESPECT deep link (`auth=Basic <base64>`). The
   * Basic header itself is accepted by the OPDS feeds, but the app's own
   * endpoints (e.g. `/groups`) require the JWT minted by `/login`, so we
   * upgrade when possible. This does NOT record into the recent-logins history.
   *
   * @param {string} basicAuthHeader  e.g. "Basic dXNlcjE6cGFzc3dvcmQ="
   * @returns {Promise<boolean>} true if a real session was established.
   */
  async loginFromBasicAuth(basicAuthHeader) {
    if (!basicAuthHeader || !this.getBaseUrl()) return false;
    const match = String(basicAuthHeader).match(/Basic\s+(.+)/i);
    if (!match) return false;
    let decoded;
    try {
      decoded = atob(match[1]);
    } catch (e) {
      return false;
    }
    const sep = decoded.indexOf(':');
    if (sep <= 0) return false;
    const username = decoded.slice(0, sep);
    const password = decoded.slice(sep + 1);
    try {
      await this.login(username, password, { record: false });
      console.log('[API] Upgraded RESPECT Basic credentials to a real session for', username);
      return true;
    } catch (e) {
      // The RESPECT credentials may not be a /login-able Tangerine account.
      // Keep the Basic fallback — the OPDS group/form feeds accept Basic, so
      // listing still works.
      console.warn('[API] RESPECT Basic creds are not a valid Tangerine login; keeping Basic fallback:', e.message);
      return false;
    }
  },

  async getGroups() {
    // First try resolving the learningUnits URL (may fetch manifest if respectUrl is a URL)
    const learningUnitsUrl = await this._resolveLearningUnitsUrl();

    let data;

    if (learningUnitsUrl === '__GROUPS_IN_MANIFEST__') {
      // Groups are directly in the OPDS root stored in localStorage — parse from there
      console.log('[API] Groups found directly in stored manifest');
      const manifest = localStorage.getItem('respectManifest');
      if (manifest) {
        try {
          data = JSON.parse(manifest);
        } catch (e) {
          data = null;
        }
      }
      if (!data || !data.navigation) {
        // Fallback: stored data didn't have navigation after all
        data = null;
      }
    }

    if (!data) {
      const url = learningUnitsUrl && learningUnitsUrl !== '__GROUPS_IN_MANIFEST__'
        ? learningUnitsUrl
        : `${this.getBaseUrl()}/groups`;
      console.log('[API] GET groups request to:', url);
      const response = await httpClient.get(url, {
        'Authorization': localStorage.getItem('token')
      });
      console.log('[API] GET groups response status:', response.status);
      if (!response.ok) {
        const errorText = await response.text();
        console.log('[API] GET groups error body:', errorText);
        throw new Error('Failed to fetch groups: ' + response.status);
      }
      data = await response.json();
    }

    // Transform OPDS navigation entries into the format views.js expects
    if (data && data.navigation && Array.isArray(data.navigation)) {
      console.log('[API] Transforming OPDS navigation to group objects');
      return data.navigation.map(entry => ({
        attributes: {
          name: extractGroupId(entry.href),
          label: entry.title
        },
        id: extractGroupId(entry.href),
        name: extractGroupId(entry.href),
        title: entry.title,
        _opdsHref: entry.href,
        _opdsType: entry.type
      }));
    }

    return data || [];
  },

  /**
   * Construct the OPDS URL for a group's forms list.
   * Uses the base OPDS pattern: /opds/groups/{groupId}?respectToken=...
   */
  _buildGroupOpdsUrl(groupId) {
    const token = this._getRespectToken();
    const base = this.getBaseUrl();
    if (token) {
      return `${base}/opds/groups/${groupId}?respectToken=${token}`;
    }
    return `${base}/opds/groups/${groupId}`;
  },

  async getFormsForGroup(groupId) {
    const url = this._buildGroupOpdsUrl(groupId);
    console.log('[API] GET forms request to:', url);
    const response = await httpClient.get(url, {
      'Authorization': localStorage.getItem('token')
    });
    console.log('[API] GET forms response status:', response.status);
    if (!response.ok) {
      const errorText = await response.text();
      console.log('[API] GET forms error body:', errorText);
      throw new Error('Failed to fetch forms: ' + response.status);
    }
    const data = await response.json();

    // Transform OPDS publications into the format views.js expects
    if (data.publications && Array.isArray(data.publications)) {
      console.log('[API] Transforming OPDS publications to form objects');
      return data.publications.map(pub => {
        const formId = extractFormId(
          (pub.metadata && pub.metadata.identifier) || ''
        );
        const openAccessLink = (pub.links || []).find(
          l => l.rel === 'http://opds-spec.org/acquisition/open-access'
        );
        return {
          id: formId,
          title: (pub.metadata && pub.metadata.title) || formId || 'Unnamed Form',
          name: (pub.metadata && pub.metadata.title) || formId,
          modified: (pub.metadata && pub.metadata.modified) || null,
          _openAccessUrl: openAccessLink
            ? openAccessLink.href
            : null
        };
      });
    }

    return data;
  },

  async getGroupLabel(groupId) {
    // The group title comes from the OPDS navigation (already available).
    // Fallback: fetch the group document from the API.
    const url = `${this.getBaseUrl()}/api/${groupId}`;
    console.log('[API] GET group label request to:', url);
    try {
      const response = await httpClient.get(url, {
        'Authorization': localStorage.getItem('token')
      });
      if (!response.ok) {
        console.warn('[API] Failed to fetch group label for', groupId, response.status);
        return null;
      }
      const doc = await response.json();
      return doc.label || null;
    } catch (err) {
      console.warn('[API] Error fetching group label for', groupId, err);
      return null;
    }
  },

  logout() {
    localStorage.removeItem('token');
    localStorage.removeItem('respectUrl');
    localStorage.removeItem('username');
    localStorage.removeItem('respectManifest');
  }
};