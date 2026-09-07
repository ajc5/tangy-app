// View management
const views = {
  _history: [],
  _currentGroupId: null,
  _currentGroupName: null,
  _cachedItems: new Set(JSON.parse(localStorage.getItem('cached-items') || '[]')),

  _markCached(key) {
    this._cachedItems.add(key);
    localStorage.setItem('cached-items', JSON.stringify([...this._cachedItems]));
  },

  _unmarkCached(key) {
    this._cachedItems.delete(key);
    localStorage.setItem('cached-items', JSON.stringify([...this._cachedItems]));
  },

  _isCached(key) {
    return this._cachedItems.has(key);
  },

  _setDownloadBtnCached(buttonEl) {
    buttonEl.textContent = '✓';
    buttonEl.style.color = '#4caf50';
    buttonEl.style.borderColor = '';
    buttonEl.disabled = false;
    buttonEl.style.opacity = '1';
  },

  _setDownloadBtnUncached(buttonEl) {
    buttonEl.textContent = '⬇';
    buttonEl.style.color = '';
    buttonEl.style.borderColor = '';
    buttonEl.disabled = false;
    buttonEl.style.opacity = '1';
  },

  // ── Pinned-URL tracking (so uncaching can evict the right disk entries) ──

  _getPinnedUrls(key) {
    try {
      const map = JSON.parse(localStorage.getItem('cached-urls') || '{}');
      return map[key] || [];
    } catch (e) { return []; }
  },

  _savePinnedUrls(key, urls) {
    const map = JSON.parse(localStorage.getItem('cached-urls') || '{}');
    map[key] = Array.isArray(urls) ? urls : [];
    localStorage.setItem('cached-urls', JSON.stringify(map));
  },

  _removePinnedUrls(key) {
    const map = JSON.parse(localStorage.getItem('cached-urls') || '{}');
    delete map[key];
    localStorage.setItem('cached-urls', JSON.stringify(map));
  },

  _getGroupFormKeys(groupId) {
    try {
      const map = JSON.parse(localStorage.getItem('cached-group-forms') || '{}');
      return map[groupId] || [];
    } catch (e) { return []; }
  },

  _saveGroupFormKeys(groupId, keys) {
    const map = JSON.parse(localStorage.getItem('cached-group-forms') || '{}');
    map[groupId] = Array.isArray(keys) ? keys : [];
    localStorage.setItem('cached-group-forms', JSON.stringify(map));
  },

  _removeGroupFormKeys(groupId) {
    const map = JSON.parse(localStorage.getItem('cached-group-forms') || '{}');
    delete map[groupId];
    localStorage.setItem('cached-group-forms', JSON.stringify(map));
  },

  // Remove URLs from the TangyCache disk cache (native). Web is a no-op.
  async _evictUrls(urls) {
    const unique = [...new Set((urls || []).filter(Boolean))];
    if (unique.length === 0) return;
    const plugin = window.Capacitor?.Plugins?.TangyCache;
    if (plugin && plugin.evict) {
      try {
        await plugin.evict({ urls: unique });
      } catch (e) {
        console.warn('[VIEWS] evict failed:', e);
      }
    }
  },

  /**
   * Shared header bar used on both logged-in and login screens.
   *
   * @param {Object}   [options]
   * @param {string}   [options.title]      Optional title shown next to the logo (logged-in pages).
   * @param {boolean}  [options.showBack]   Show the back button (logged-in pages).
   * @param {boolean}  [options.loginMode]  Render the login dropdown (Clear saved data only)
   *                                        instead of the logged-in dropdown
   *                                        (RESPECT link / Clear saved data / Logout).
   */
  renderHeader({ title = '', showBack = false, loginMode = false } = {}) {
    // Remove existing menu bar if any
    const existingMenu = document.getElementById('menu-bar');
    if (existingMenu) existingMenu.remove();

    const menuBar = document.createElement('div');
    menuBar.id = 'menu-bar';
    menuBar.className = 'menu-bar';

    // Left side: (back button) + logo + (title)
    const leftSide = document.createElement('div');
    leftSide.className = 'menu-left';

    if (showBack) {
      // Back button (only enabled if there's history)
      const backBtn = document.createElement('button');
      backBtn.className = 'menu-btn menu-back';
      backBtn.textContent = '←';
      backBtn.disabled = this._history.length === 0;
      backBtn.style.opacity = this._history.length === 0 ? '0.5' : '1';
      backBtn.addEventListener('click', () => this.goBack());
      leftSide.appendChild(backBtn);
    }

    const logoImg = document.createElement('img');
    logoImg.src = 'img/logo-menu.png';
    logoImg.alt = 'Tangerine';
    logoImg.className = 'menu-logo';
    if (!loginMode) {
      logoImg.addEventListener('click', () => this.goHome());
    }
    leftSide.appendChild(logoImg);

    if (title) {
      const titleEl = document.createElement('span');
      titleEl.className = 'menu-title';
      titleEl.textContent = title;
      leftSide.appendChild(titleEl);
    }

    menuBar.appendChild(leftSide);

    // Right side: hamburger toggle + dropdown menu
    const actions = document.createElement('div');
    actions.className = 'menu-actions';

    const menuToggle = document.createElement('button');
    menuToggle.className = 'menu-btn menu-hamburger';
    menuToggle.textContent = '☰';
    menuToggle.setAttribute('aria-label', 'Menu');
    actions.appendChild(menuToggle);

    const dropdown = document.createElement('div');
    dropdown.className = 'menu-dropdown';

    if (loginMode) {
      // Login screen: only "Clear Saved Servers & Usernames" is available.
      dropdown.innerHTML = `
        <div class="dropdown-info">
          <span class="dropdown-info-label">Login</span>
          <span class="dropdown-info-url">${api.getBaseUrl() ? 'Server: ' + api.getBaseUrl() : 'No server selected'}</span>
        </div>
        <button class="dropdown-item dropdown-item-clear">Clear Saved Servers &amp; Usernames</button>
      `;
      dropdown.querySelector('.dropdown-item-clear').addEventListener('click', () => {
        dropdown.classList.remove('open');
        this.clearLoginData();
      });
    } else {
      // Logged-in screen: RESPECT link, Clear saved data, Logout.
      dropdown.innerHTML = `
        <div class="dropdown-info">
          <span class="dropdown-info-label">${api.getUsername() || 'Unknown'}</span>
          <span class="dropdown-info-url">${api.getBaseUrl() || 'No server'}</span>
        </div>
        <button class="dropdown-item dropdown-item-respect">Copy RESPECT Link</button>
        <button class="dropdown-item dropdown-item-clear">Clear Saved Servers &amp; Usernames</button>
        <button class="dropdown-item dropdown-item-logout">Logout</button>
      `;
      dropdown.querySelector('.dropdown-item-logout').addEventListener('click', () => {
        dropdown.classList.remove('open');
        this.logout();
      });
      dropdown.querySelector('.dropdown-item-clear').addEventListener('click', () => {
        dropdown.classList.remove('open');
        this.clearLoginData();
      });
      dropdown.querySelector('.dropdown-item-respect').addEventListener('click', () => {
        dropdown.classList.remove('open');
        const link = api.getRespectUrl();
        if (!link) {
          alert('No RESPECT URL available. Please log in again.');
          return;
        }
        navigator.clipboard.writeText(link).then(() => {
          // Brief visual feedback
          const btn = dropdown.querySelector('.dropdown-item-respect');
          const origText = btn.textContent;
          btn.textContent = '✓ Copied!';
          setTimeout(() => { btn.textContent = origText; }, 2000);
        }).catch(() => {
          // Fallback for older browsers
          const textArea = document.createElement('textarea');
          textArea.value = link;
          document.body.appendChild(textArea);
          textArea.select();
          document.execCommand('copy');
          document.body.removeChild(textArea);
          const btn = dropdown.querySelector('.dropdown-item-respect');
          const origText = btn.textContent;
          btn.textContent = '✓ Copied!';
          setTimeout(() => { btn.textContent = origText; }, 2000);
        });
      });
    }

    actions.appendChild(dropdown);

    // Toggle dropdown
    menuToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.classList.toggle('open');
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
      if (!dropdown.contains(e.target) && e.target !== menuToggle) {
        dropdown.classList.remove('open');
      }
    });

    menuBar.appendChild(actions);
    document.body.prepend(menuBar);
  },

  removeMenuBar() {
    const menuBar = document.getElementById('menu-bar');
    if (menuBar) menuBar.remove();
  },

  goHome() {
    this._history = [];
    this._currentGroupId = null;
    this._currentGroupName = null;
    this.renderGroups();
  },

  goBack() {
    if (this._history.length === 0) return;
    const prev = this._history.pop();
    if (prev === 'groups') {
      this._currentGroupId = null;
      this._currentGroupName = null;
      this.renderGroups();
    } else if (prev === 'forms') {
      this.renderForms(this._currentGroupId, this._currentGroupName);
    }
  },

  logout() {
    this._history = [];
    this._currentGroupId = null;
    this._currentGroupName = null;
    api.logout();
    const serverUrl = api.getBaseUrl();
    this.removeMenuBar();
    // Clear browser history and start fresh login flow
    if (history.length > 1) {
      history.go(-(history.length - 1));
      // After clearing, push fresh entries
      setTimeout(() => {
        if (serverUrl) {
          this.renderLoginStep2();
        } else {
          this.renderLoginStep1();
        }
      }, 50);
      return;
    }
    if (serverUrl) {
      this.renderLoginStep2();
    } else {
      this.renderLoginStep1();
    }
  },

  /**
   * Clear every saved server/username plus the current session, then return
   * to a clean login screen. Invoked from the burger menu on any screen.
   */
  clearLoginData() {
    if (!confirm('Clear all saved servers and usernames?\n\nThis will remove stored login history and log you out.')) {
      return;
    }
    this._history = [];
    this._currentGroupId = null;
    this._currentGroupName = null;
    api.clearAllLoginData();
    this.removeMenuBar();
    if (history.length > 1) {
      history.go(-(history.length - 1));
      setTimeout(() => this.renderLoginStep1(), 50);
      return;
    }
    this.renderLoginStep1();
  },

  /**
   * Populate the recent-servers suggestion dropdown shown below the server URL
   * text field. Uses a custom list so placement is controlled (native Android
   * <datalist> popups render above the field and cannot be repositioned).
   */
  _renderRecentServers() {
    const input = document.getElementById('server-url');
    const list = document.getElementById('server-suggest-list');
    if (!input || !list) return;
    const servers = api.getRecentServers();
    list.innerHTML = '';
    servers.forEach((server) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'suggest-item';
      item.textContent = server;
      item.title = server;
      item.addEventListener('click', () => {
        api.setBaseUrl(server);
        this.renderLoginStep2();
      });
      list.appendChild(item);
    });
    // Keep the input focused while the user taps an item, so the dropdown
    // doesn't dismiss before the tap lands.
    list.addEventListener('pointerdown', (e) => e.preventDefault());
    input.addEventListener('focus', () => {
      if (list.children.length) list.classList.add('open');
    });
    input.addEventListener('blur', () => {
      setTimeout(() => list.classList.remove('open'), 150);
    });
  },

  /**
   * Populate the recent-usernames suggestion dropdown shown below the username
   * text field.
   */
  _renderRecentUsernames() {
    const input = document.getElementById('username');
    const list = document.getElementById('username-suggest-list');
    if (!input || !list) return;
    const usernames = api.getRecentUsernames(api.getBaseUrl());
    list.innerHTML = '';
    usernames.forEach((username) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'suggest-item';
      item.textContent = username;
      item.addEventListener('click', () => {
        input.value = username;
        list.classList.remove('open');
        const passwordInput = document.getElementById('password');
        if (passwordInput) passwordInput.focus();
      });
      list.appendChild(item);
    });
    list.addEventListener('pointerdown', (e) => e.preventDefault());
    input.addEventListener('focus', () => {
      if (list.children.length) list.classList.add('open');
    });
    input.addEventListener('blur', () => {
      setTimeout(() => list.classList.remove('open'), 150);
    });
  },

  renderLoginStep1(pushHistory = true) {
    this.renderHeader({ loginMode: true });
    const container = document.getElementById('page-container');
    container.innerHTML = `
      <div class="screen" id="login-step1">
        <div class="card">
          <img src="img/logo-login.png" alt="Tangerine" class="login-logo">
          <h1>Enter your server URL</h1>
          <div class="input-suggest">
            <input type="text" id="server-url" placeholder="https://your-server.com" value="${api.getBaseUrl()}" autocomplete="off">
            <div class="suggest-list" id="server-suggest-list"></div>
          </div>
          <button id="connect-btn">Connect</button>
          <div id="step1-error" class="error"></div>
        </div>
      </div>
    `;
    if (pushHistory) {
      history.pushState({ page: 'step1' }, '');
    }
    document.getElementById('connect-btn').addEventListener('click', () => {
      const url = document.getElementById('server-url').value.trim();
      if (!url) {
        document.getElementById('step1-error').textContent = 'Please enter a server URL.';
        return;
      }
      api.setBaseUrl(url);
      this.renderLoginStep2();
    });
    this._renderRecentServers();
  },

  renderLoginStep2(pushHistory = true) {
    this.renderHeader({ loginMode: true });
    const container = document.getElementById('page-container');
    const serverUrl = api.getBaseUrl();
    container.innerHTML = `
      <div class="screen" id="login-step2">
        <div class="card">
          <img src="img/logo-login.png" alt="Tangerine" class="login-logo">
          <div class="server-info">
            <label>Server:</label>
            <span id="server-display">${serverUrl}</span>
            <button id="change-server-btn" class="link-btn">Change</button>
          </div>
          <form id="login-form">
          <div class="input-suggest">
            <input type="text" id="username" placeholder="Username" autocomplete="off">
            <div class="suggest-list" id="username-suggest-list"></div>
          </div>
          <input type="password" id="password" placeholder="Password" autocomplete="current-password">
            <button type="submit" id="login-btn">Login</button>
          </form>
          <div id="step2-error" class="error"></div>
      </div>
      </div>
    `;
    if (pushHistory) {
      history.pushState({ page: 'step2' }, '');
    }
    document.getElementById('change-server-btn').addEventListener('click', () => {
      this.renderLoginStep1();
    });
    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = document.getElementById('username').value.trim();
      const password = document.getElementById('password').value.trim();
      if (!username || !password) {
        document.getElementById('step2-error').textContent = 'Please fill in all fields.';
        return;
      }
      try {
        await api.login(username, password);
        this.renderGroups();
      } catch (err) {
        document.getElementById('step2-error').textContent = err.message;
      }
    });
    this._renderRecentUsernames();
  },

  async renderGroups() {
    // Push browser history entry so back button fires popstate
    if (this._history.length === 0) {
      history.pushState({ page: 'groups' }, '');
    }
    const container = document.getElementById('page-container');
    container.innerHTML = `<div class="screen" id="groups"><h1>Groups</h1><ul id="group-list"></ul></div>`;
    this.renderHeader({ title: 'Groups', showBack: true });
    const list = document.getElementById('group-list');
    try {
      const groups = await api.getGroups();
      console.log('[VIEWS] renderGroups received:', JSON.stringify(groups));

      // Show debug: raw API response
      const debugPre = document.createElement('pre');
      debugPre.style.cssText = 'font-size:10px;background:#ffe0e0;padding:4px;margin:4px 0;max-height:80px;overflow:auto;';
      debugPre.textContent = 'DEBUG raw: ' + JSON.stringify(groups).slice(0, 600);
      container.appendChild(debugPre);

      // Sort groups alphabetically by display name
      groups.sort((a, b) => {
        const nameA = ((a.attributes && a.attributes.label) || (a.attributes && a.attributes.name) || a.attributes?.name || a.id || a.name || '').toLowerCase();
        const nameB = ((b.attributes && b.attributes.label) || (b.attributes && b.attributes.name) || b.attributes?.name || b.id || b.name || '').toLowerCase();
        return nameA.localeCompare(nameB);
      });
      groups.forEach(group => {
        // The Tangerine API returns groups with attributes: { attributes: { name: '<uuid>', label: '...', roles: [...] } }
        const groupId = group.attributes ? group.attributes.name : (group.id || group.name);
        const displayName = (group.attributes && group.attributes.label) || (group.attributes && group.attributes.name) || groupId;
        console.log('[VIEWS] Processing group:', { groupId, displayName, raw: JSON.stringify(group) });
        const li = document.createElement('li');
        li.className = 'list-item';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'list-item-name';
        nameSpan.textContent = displayName;
        li.appendChild(nameSpan);

        const dlBtn = document.createElement('button');
        dlBtn.className = 'download-btn';
        dlBtn.title = 'Pin all forms in this group for offline use';
        if (this._isCached('group:' + groupId)) {
          this._setDownloadBtnCached(dlBtn);
        } else {
          dlBtn.textContent = '⬇';
        }
        dlBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.cacheGroupResources(groupId, dlBtn);
        });
        li.appendChild(dlBtn);

        li.addEventListener('click', () => {
          this._history.push('groups');
          this._currentGroupId = groupId;
          this._currentGroupName = displayName;
          history.pushState({ page: 'forms', groupId }, '');
          this.renderForms(groupId, displayName);
        });
        list.appendChild(li);
      });
      if (groups.length === 0) {
        container.innerHTML += `<div class="error">No groups found</div>`;
      }
    } catch (err) {
      console.log('[VIEWS] renderGroups error:', err);
      container.innerHTML += `<div class="error">${err.message}</div>`;
    }
  },

  async renderForms(groupId, groupName) {
    const container = document.getElementById('page-container');
    container.innerHTML = `<div class="screen" id="forms"><h1>Forms - ${groupName}</h1><ul id="form-list"></ul></div>`;
    this.renderHeader({ title: `Forms - ${groupName}`, showBack: true });
    const list = document.getElementById('form-list');
    try {
      console.log('[VIEWS] renderForms called with:', { groupId, groupName });
      const forms = await api.getFormsForGroup(groupId);
      console.log('[VIEWS] renderForms received:', forms);
      // Sort forms alphabetically by form name
      forms.sort((a, b) => {
        const nameA = (a.title || a.name || a.id || '').toLowerCase();
        const nameB = (b.title || b.name || b.id || '').toLowerCase();
        return nameA.localeCompare(nameB);
      });
      forms.forEach(form => {
        const formName = form.title || form.name || form.id || 'Unnamed Form';
        const formId = form.id;
        // Use OPDS open-access URL when available, otherwise construct from base
        const formUrl = form._openAccessUrl
          ? (form._openAccessUrl.startsWith('http')
              ? form._openAccessUrl
              : `${api.getBaseUrl()}${form._openAccessUrl}`)
          : `${api.getBaseUrl()}/releases/prod/online-survey-apps/${groupId}/${formId}/#/form/${formId}`;
        console.log('[VIEWS] Processing form:', { formName, formId, formUrl, raw: form });
        const li = document.createElement('li');
        li.className = 'list-item';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'list-item-name';
        nameSpan.textContent = formName;
        li.appendChild(nameSpan);

        const dlBtn = document.createElement('button');
        dlBtn.className = 'download-btn';
        dlBtn.title = 'Pin this form for offline use';
        if (this._isCached('form:' + formUrl) || this._isCached('group:' + groupId)) {
          this._setDownloadBtnCached(dlBtn);
        } else {
          dlBtn.textContent = '⬇';
        }
        dlBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.cacheFormResources(formUrl, dlBtn);
        });
        li.appendChild(dlBtn);

        li.addEventListener('click', () => this.openFormInWebView(formUrl));
        list.appendChild(li);
      });
      if (forms.length === 0) {
        container.innerHTML += `<div class="error">No forms found for this group</div>`;
      }
    } catch (err) {
      console.log('[VIEWS] renderForms error:', err);
      container.innerHTML += `<div class="error">${err.message}</div>`;
    }
  },

  /**
   * Open a form / lesson in a full-screen WebView.
   *
   * @param {string} url  The form URL (normal browsing) or a RESPECT deep-link
   *                      lesson URL (launched by the RESPECT launcher).
   * @param {Object} [options]
   * @param {boolean} [options.launchedFromRespect] True when the lesson was opened via a
   *   RESPECT deep link. Closing such a lesson returns the user to the RESPECT launcher;
   *   other forms keep current behaviour (close returns to the Tangerine list it came from).
   * @param {string}  [options.ipcPackage] The launcher's package name (`xapiIpcPackage`).
   */
  openFormInWebView(url, options = {}) {
    if (!url) {
      alert('No URL available for this form.');
      return;
    }
    const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
    const launchedFromRespect = !!options.launchedFromRespect;
    const ipcPackage = options.ipcPackage || null;

    console.log('[VIEWS] Opening form:', url, { launchedFromRespect, ipcPackage });

    try {
      // Prefer TangyCache.openCachedWebView (OkHttp + CacheInterceptor)
      if (isNative && window.Capacitor.Plugins && window.Capacitor.Plugins.TangyCache
          && window.Capacitor.Plugins.TangyCache.openCachedWebView) {
        console.log('[VIEWS] Using cached WebView:', url);
        window.Capacitor.Plugins.TangyCache.openCachedWebView({
          url: url,
          showToolbar: true,
          closeButtonText: 'Close',
          launchedFromRespect: launchedFromRespect,
          ipcPackage: ipcPackage
        }).catch(err => {
          console.error('[VIEWS] cached WebView failed:', err);
          this._openInAppBrowserFallback(url, isNative, { launchedFromRespect, ipcPackage });
        });
      } else if (isNative && window.Capacitor.Plugins && window.Capacitor.Plugins.InAppBrowser) {
        this._openInAppBrowserFallback(url, isNative, { launchedFromRespect, ipcPackage });
      } else if (isNative) {
        console.error('[VIEWS] No cached WebView or InAppBrowser');
        alert('No browser plugin available.');
      } else {
        const win = window.open(url, '_blank');
        if (!win) alert('Popup blocked. Please allow popups for:\n\n' + url);
      }
    } catch (e) {
      console.error('[VIEWS] Error opening form:', e);
      alert('Could not open form:\n\n' + url);
    }
  },

  _openInAppBrowserFallback(url, isNative, options = {}) {
    if (!isNative || !window.Capacitor.Plugins.InAppBrowser) {
      alert('Cannot open form: no browser available.');
      return;
    }
    const launchedFromRespect = !!options.launchedFromRespect;
    const ipcPackage = options.ipcPackage || null;
    console.log('[VIEWS] Opening form in InAppBrowser (fallback):', url);
    window.Capacitor.Plugins.InAppBrowser.openInWebView({
      url: url,
      options: {
        showToolbar: true,
        showURL: false,
        closeButtonText: 'Close',
        toolbarPosition: 0,
        showNavigationButtons: true,
        leftToRight: false,
        clearCache: false,
        clearSessionCache: false,
        mediaPlaybackRequiresUserAction: false,
        android: {
          allowZoom: true,
          hardwareBack: true,
          pauseMedia: true,
          isIsolated: true
        }
      },
      // Best-effort: carried through so a native consumer could use it to hand
      // a RESPECT-launched lesson back to the launcher on close.
      launchedFromRespect: launchedFromRespect,
      ipcPackage: ipcPackage
    }).catch(err => {
      console.error('[VIEWS] InAppBrowser failed:', err);
      alert('Failed to open form: ' + (err.message || 'Unknown error'));
    });
  },

  /**
   * Toggle offline caching for a single form: pin it if not already cached,
   * or uncache (evict from disk) if it is.
   */
  async cacheFormResources(formUrl, buttonEl) {
    const cacheKey = 'form:' + formUrl;

    // Toggle — already cached: uncache it.
    if (this._isCached(cacheKey)) {
      console.log('[VIEWS] Uncaching form:', formUrl);
      buttonEl.textContent = '⏳';
      buttonEl.disabled = true;
      buttonEl.style.opacity = '0.7';
      try {
        await this._evictUrls(this._getPinnedUrls(cacheKey));
        this._unmarkCached(cacheKey);
        this._removePinnedUrls(cacheKey);
        this._setDownloadBtnUncached(buttonEl);
        console.log('[VIEWS] Uncached form:', formUrl);
      } catch (err) {
        console.error('[VIEWS] Failed to uncache form:', err);
        this._setDownloadBtnCached(buttonEl);
      }
      return;
    }

    buttonEl.textContent = '⏳';
    buttonEl.disabled = true;
    buttonEl.style.opacity = '0.7';

    try {
      const baseUrl = formUrl.replace(/#.*$/, '');
      const urlsToCache = [baseUrl];
      try {
        const response = await httpClient.get(baseUrl, {
          'Authorization': localStorage.getItem('token')
        });
        if (response.ok) {
          const text = await response.text();
          const ct = response.headers.get('content-type') || '';
          // Check if response is a Readium OPDS JSON manifest
          if (ct.includes('/json') || ct.includes('opds') || text.trim().startsWith('{')) {
            const resourceUrls = this._extractReadiumResources(text, baseUrl);
            console.log('[VIEWS] Readium manifest found:', resourceUrls.length, 'resources');
            urlsToCache.push(...resourceUrls);
          } else {
            const resourceUrls = this._extractResourceUrls(text, baseUrl);
            urlsToCache.push(...resourceUrls);
          }
        }
      } catch (e) {
        console.warn('[VIEWS] Could not fetch form page for resource discovery:', e);
      }

      console.log('[VIEWS] Pinning form resources via TangyCache:', urlsToCache.length, 'URLs');
      const result = await cacheService.downloadAndRetain(
        urlsToCache.map(url => ({ url, remark: 'form-cache' }))
      );
      console.log('[VIEWS] Pin result:', result.cached, 'cached,', result.failed, 'failed');

      this._markCached(cacheKey);
      this._savePinnedUrls(cacheKey, result.urls);
      this._setDownloadBtnCached(buttonEl);
    } catch (err) {
      console.error('[VIEWS] Failed to pin form:', err);
      buttonEl.textContent = '✗';
      buttonEl.style.color = '#ff0000';
      setTimeout(() => {
        buttonEl.textContent = '⬇';
        buttonEl.style.color = '';
        buttonEl.disabled = false;
        buttonEl.style.opacity = '1';
      }, 2000);
    }
  },

  /**
   * Toggle offline caching for a whole group: pin all forms if not already
   * cached, or uncache (evict from disk + unmark) the group and its forms.
   */
  async cacheGroupResources(groupId, buttonEl) {
    const cacheKey = 'group:' + groupId;

    // Toggle — already cached: uncache the group and its child forms.
    if (this._isCached(cacheKey)) {
      console.log('[VIEWS] Uncaching group:', groupId);
      buttonEl.textContent = '⏳';
      buttonEl.disabled = true;
      buttonEl.style.opacity = '0.7';
      try {
        // Evict every URL pinned for the group or any of its child forms.
        const urlsToEvict = [...this._getPinnedUrls(cacheKey)];
        this._getGroupFormKeys(groupId).forEach(k => {
          urlsToEvict.push(...this._getPinnedUrls(k));
        });

        await this._evictUrls(urlsToEvict);

        this._unmarkCached(cacheKey);
        this._getGroupFormKeys(groupId).forEach(k => {
          this._unmarkCached(k);
          this._removePinnedUrls(k);
        });
        this._removePinnedUrls(cacheKey);
        this._removeGroupFormKeys(groupId);
        this._setDownloadBtnUncached(buttonEl);
        console.log('[VIEWS] Uncached group:', groupId);
      } catch (err) {
        console.error('[VIEWS] Failed to uncache group:', err);
        this._setDownloadBtnCached(buttonEl);
      }
      return;
    }

    buttonEl.textContent = '⏳';
    buttonEl.disabled = true;
    buttonEl.style.opacity = '0.7';

    try {
      const forms = await api.getFormsForGroup(groupId);
      console.log('[VIEWS] Pinning group forms:', forms.length);

      const allUrls = [];
      const childFormKeys = [];
      for (const form of forms) {
        const formId = form.id;
        const formUrl = form._openAccessUrl
          ? (form._openAccessUrl.startsWith('http')
              ? form._openAccessUrl
              : `${api.getBaseUrl()}${form._openAccessUrl}`)
          : `${api.getBaseUrl()}/releases/prod/online-survey-apps/${groupId}/${formId}/#/form/${formId}`;
        const baseUrl = formUrl.replace(/#.*$/, '');
        allUrls.push(baseUrl);

        // Discover sub-resources
        try {
          const response = await httpClient.get(baseUrl, {
            'Authorization': localStorage.getItem('token')
          });
          if (response.ok) {
            const text = await response.text();
            const ct = response.headers.get('content-type') || '';
            if (ct.includes('/json') || ct.includes('opds') || text.trim().startsWith('{')) {
              const resourceUrls = this._extractReadiumResources(text, baseUrl);
              allUrls.push(...resourceUrls);
            } else {
              const resourceUrls = this._extractResourceUrls(text, baseUrl);
              allUrls.push(...resourceUrls);
            }
          }
        } catch (e) {
          console.warn(`[VIEWS] Could not fetch form ${formId} for resource discovery:`, e);
        }

        this._markCached('form:' + formUrl);
        childFormKeys.push('form:' + formUrl);
      }

      const uniqueUrls = [...new Set(allUrls)];
      console.log('[VIEWS] Pinning group resources via Respect:', uniqueUrls.length, 'URLs');
      const result = await cacheService.downloadAndRetain(
        uniqueUrls.map(url => ({ url, remark: 'group-cache' }))
      );
      console.log('[VIEWS] Pin result:', result.cached, 'cached,', result.failed, 'failed');

      this._markCached(cacheKey);
      this._savePinnedUrls(cacheKey, result.urls);
      this._saveGroupFormKeys(groupId, childFormKeys);
      this._setDownloadBtnCached(buttonEl);
    } catch (err) {
      console.error('[VIEWS] Failed to pin group:', err);
      buttonEl.textContent = '✗';
      buttonEl.style.color = '#ff0000';
      setTimeout(() => {
        buttonEl.textContent = '⬇';
        buttonEl.style.color = '';
        buttonEl.disabled = false;
        buttonEl.style.opacity = '1';
      }, 2000);
    }
  },

  /**
   * Extract resource URLs (CSS, JS, images) from an HTML string.
   */
  _extractResourceUrls(html, baseUrl) {
    const urls = [];
    const linkRegex = /<link[^>]+href=["']([^"']+)["']/gi;
    let match;
    while ((match = linkRegex.exec(html)) !== null) {
      urls.push(this._resolveUrl(match[1], baseUrl));
    }
    const scriptRegex = /<script[^>]+src=["']([^"']+)["']/gi;
    while ((match = scriptRegex.exec(html)) !== null) {
      urls.push(this._resolveUrl(match[1], baseUrl));
    }
    const imgRegex = /<img[^>]+src=["']([^"']+)["']/gi;
    while ((match = imgRegex.exec(html)) !== null) {
      urls.push(this._resolveUrl(match[1], baseUrl));
    }
    return urls;
  },

  /**
   * Extract resource URLs from a Readium OPDS JSON manifest (resources array + images + links).
   */
  _extractReadiumResources(jsonStr, baseUrl) {
    try {
      const manifest = JSON.parse(jsonStr);
      const urls = [];
      // Resources array
      if (Array.isArray(manifest.resources)) {
        for (const res of manifest.resources) {
          if (res.href) urls.push(this._resolveUrl(res.href, baseUrl));
        }
      }
      // Images array
      if (Array.isArray(manifest.images)) {
        for (const img of manifest.images) {
          if (img.href) urls.push(this._resolveUrl(img.href, baseUrl));
        }
      }
      // Links array (acquisition links)
      if (Array.isArray(manifest.links)) {
        for (const link of manifest.links) {
          if (link.href && link.rel !== 'self') urls.push(this._resolveUrl(link.href, baseUrl));
        }
      }
      return [...new Set(urls)];
    } catch (e) {
      console.warn('[VIEWS] Failed to parse Readium manifest:', e.message);
      return [];
    }
  },

  _resolveUrl(url, baseUrl) {
    try {
      return new URL(url, baseUrl).href;
    } catch (e) {
      return url;
    }
  },

  init() {
    // Intercept Android back button via browser history (no plugin needed)
    window.addEventListener('popstate', (e) => {
      console.log('[VIEWS] popstate, state:', e.state, 'history:', this._history.length);
      if (this._history.length > 0) {
        this.goBack();
      } else if (document.getElementById('group-list')) {
        // On groups page — confirm logout
        if (confirm('Log out and return to the login screen?')) {
          this.logout();
        } else {
          // Stay on page — push state back so next back still works
          history.pushState({ page: 'groups' }, '');
        }
      } else if (e.state && e.state.page === 'step1') {
        // Back pressed on step2 → go to step1 (state already popped, step1 is current)
        this.renderLoginStep1(false);
      } else if (e.state && e.state.page === 'step2') {
        // Edge case: back pressed, step2 is now current (shouldn't normally happen)
        this.renderLoginStep2(false);
      }
      // e.state is null: no more history — next back press will exit the app
    });

    // Check if already logged in
    const token = localStorage.getItem('token');
    const serverUrl = api.getBaseUrl();
    if (token && serverUrl) {
      this.renderGroups();
    } else if (serverUrl) {
      this.renderLoginStep2();
    } else {
      this.renderLoginStep1();
    }
  },
};