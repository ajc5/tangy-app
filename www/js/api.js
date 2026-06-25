// API utility for communicating with Tangerine server
// Uses httpClient (native Capacitor HTTP when available, fetch fallback)
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
    // Server returns { data: { token: "...", respectUrl: "..." } }
    if (result.data && result.data.token) {
      localStorage.setItem('token', result.data.token);
      localStorage.setItem('username', username);
    }
    if (result.data && result.data.respectUrl) {
      localStorage.setItem('respectUrl', result.data.respectUrl);
    }
    return result;
  },

  async getGroups() {
    const url = `${this.getBaseUrl()}/groups`;
    console.log('[API] GET groups request to:', url);
    try {
      const response = await httpClient.get(url, {
        'Authorization': localStorage.getItem('token')
      });
      console.log('[API] GET groups response status:', response.status);
      if (!response.ok) {
        const errorText = await response.text();
        console.log('[API] GET groups error body:', errorText);
        throw new Error('Failed to fetch groups: ' + response.status);
      }
      const data = await response.json();

      // Cache groups for offline use
      try {
        await cacheService.store(
          `${this.getBaseUrl()}/groups`,
          'application/json',
          JSON.stringify(data)
        );
      } catch (cacheErr) {
        console.warn('[API] Failed to cache groups:', cacheErr);
      }

      return data;
    } catch (networkErr) {
      console.warn('[API] Network error fetching groups, trying cache:', networkErr);
      const cached = await cacheService.retrieve(url);
      if (cached) {
        console.log('[API] Returning cached groups');
        return JSON.parse(cached.body);
      }
      throw networkErr;
    }
  },

  async getFormsForGroup(groupId) {
    const url = `${this.getBaseUrl()}/api/${groupId}/assets/forms.json`;
    console.log('[API] GET forms request to:', url);
    try {
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

      // Cache forms for offline use
      try {
        await cacheService.store(
          url,
          'application/json',
          JSON.stringify(data)
        );
      } catch (cacheErr) {
        console.warn('[API] Failed to cache forms:', cacheErr);
      }

      return data;
    } catch (networkErr) {
      console.warn('[API] Network error fetching forms, trying cache:', networkErr);
      const cached = await cacheService.retrieve(url);
      if (cached) {
        console.log('[API] Returning cached forms');
        return JSON.parse(cached.body);
      }
      throw networkErr;
    }
  },

  async getGroupLabel(groupId) {
    // Fetch the group document to get its label.
    // Tangerine stores group docs in the main DB, accessible via /api/<groupId>
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