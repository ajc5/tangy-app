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
   * Extract the respectToken from the stored OPDS root document or URL.
   */
  _getRespectToken() {
    const stored = localStorage.getItem('respectUrl');
    if (!stored) return '';

    // Try parsing as JSON (OPDS root document)
    try {
      const parsed = JSON.parse(stored);

      // 1. Extract token from learningUnits URL
      if (parsed && parsed.learningUnits) {
        const luUrl = new URL(parsed.learningUnits, this.getBaseUrl());
        const token = luUrl.searchParams.get('respectToken');
        if (token) return token;
      }

      // 2. Extract token from links array (OPDS catalog link)
      if (parsed && parsed.links && Array.isArray(parsed.links)) {
        const catalogLink = parsed.links.find(
          l => l.rel === 'http://opds-spec.org/catalog' && l.href
        );
        if (catalogLink) {
          const linkUrl = new URL(catalogLink.href, this.getBaseUrl());
          const token = linkUrl.searchParams.get('respectToken');
          if (token) return token;
        }
      }
    } catch (e) {
      // Not JSON — might be a plain URL string
    }

    // Try as a URL string
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
   *   2. A `links` entry with rel="http://opds-spec.org/catalog"
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

    // 2. OPDS links array — find the catalog link for groups
    if (doc && doc.links && Array.isArray(doc.links)) {
      const catalogLink = doc.links.find(
        l => l.rel === 'http://opds-spec.org/catalog'
      );
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
   * Resolve the learningUnits (groups) URL from the stored respectUrl.
   * The respectUrl in localStorage may be:
   *   - A JSON object (OPDS root document already fetched)
   *   - A URL string (manifest endpoint)
   */
  async _resolveLearningUnitsUrl() {
    const stored = localStorage.getItem('respectUrl');
    if (!stored) return null;

    // Already a JSON object (OPDS root) — extract learning units URL from it
    try {
      const parsed = JSON.parse(stored);
      const result = this._resolveDocLearningUnitsUrl(parsed);
      if (result === '__GROUPS_IN_MANIFEST__') {
        // Groups are directly in the manifest — tell getGroups to parse from localStorage
        return '__GROUPS_IN_MANIFEST__';
      }
      if (result) {
        return result;
      }
    } catch (e) {
      // Not JSON — proceed as URL string
    }

    // stored is a URL string — fetch the manifest to get the OPDS root
    try {
      console.log('[API] Fetching manifest from respectUrl:', stored);
      const response = await httpClient.get(stored, {
        'Authorization': localStorage.getItem('token')
      });
      if (response.ok) {
        const manifest = await response.json();
        console.log('[API] Manifest response:', JSON.stringify(manifest, null, 2).slice(0, 500));
        // Cache the resolved OPDS root for future use
        localStorage.setItem('respectUrl', JSON.stringify(manifest));

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

  async login(username, password) {
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
    // Server may return { data: { token: "...", respectUrl: ... } }
    // or { token: "...", respectUrl: ... } (without data wrapper)
    // respectUrl may be a JSON object (OPDS root) or a URL string

    // Check both result.data (wrapped) and result (unwrapped) for token
    const token = (result.data && result.data.token) || result.token;
    if (token) {
      localStorage.setItem('token', token);
      localStorage.setItem('username', username);
    }

    // Check both result.data and result top-level for respectUrl
    const respectUrlValue = (result.data && result.data.respectUrl) || result.respectUrl;
    if (respectUrlValue) {
      if (typeof respectUrlValue === 'object' && respectUrlValue !== null) {
        localStorage.setItem('respectUrl', JSON.stringify(respectUrlValue));
      } else {
        localStorage.setItem('respectUrl', respectUrlValue);
      }
    }
    return result;
  },

  async getGroups() {
    // First try resolving the learningUnits URL (may fetch manifest if respectUrl is a URL)
    const learningUnitsUrl = await this._resolveLearningUnitsUrl();

    let data;

    if (learningUnitsUrl === '__GROUPS_IN_MANIFEST__') {
      // Groups are directly in the OPDS root stored in localStorage — parse from there
      console.log('[API] Groups found directly in stored manifest');
      const stored = localStorage.getItem('respectUrl');
      if (stored) {
        try {
          data = JSON.parse(stored);
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
  }
};