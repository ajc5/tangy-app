// View management
const views = {
  _history: [],
  _currentGroupId: null,
  _currentGroupName: null,
  _cachedItems: new Set(JSON.parse(localStorage.getItem('tangy-cached-items') || '[]')),

  _markCached(key) {
    this._cachedItems.add(key);
    localStorage.setItem('tangy-cached-items', JSON.stringify([...this._cachedItems]));
  },

  _isCached(key) {
    return this._cachedItems.has(key);
  },

  _setDownloadBtnCached(buttonEl) {
    buttonEl.textContent = '✓';
    buttonEl.style.color = '#27ae60';
    buttonEl.style.borderColor = '#27ae60';
    buttonEl.disabled = false;
    buttonEl.style.opacity = '1';
  },

  renderMenuBar(title) {
    // Remove existing menu bar if any
    const existingMenu = document.getElementById('menu-bar');
    if (existingMenu) existingMenu.remove();

    const menuBar = document.createElement('div');
    menuBar.id = 'menu-bar';
    menuBar.className = 'menu-bar';

    // Left side: logo + title
    const leftSide = document.createElement('div');
    leftSide.className = 'menu-left';

    const logoImg = document.createElement('img');
    logoImg.src = 'img/logo-menu.png';
    logoImg.alt = 'Tangerine';
    logoImg.className = 'menu-logo';
    logoImg.addEventListener('click', () => this.goHome());
    leftSide.appendChild(logoImg);

    const titleEl = document.createElement('span');
    titleEl.className = 'menu-title';
    titleEl.textContent = title || 'Tangerine';
    leftSide.appendChild(titleEl);

    menuBar.appendChild(leftSide);

    const actions = document.createElement('div');
    actions.className = 'menu-actions';

    // Back button (only enabled if there's history)
    const backBtn = document.createElement('button');
    backBtn.className = 'menu-btn';
    backBtn.textContent = 'Back';
    backBtn.disabled = this._history.length === 0;
    backBtn.style.opacity = this._history.length === 0 ? '0.5' : '1';
    backBtn.addEventListener('click', () => this.goBack());
    actions.appendChild(backBtn);

    // Hamburger menu toggle
    const menuToggle = document.createElement('button');
    menuToggle.className = 'menu-btn menu-hamburger';
    menuToggle.textContent = '☰';
    menuToggle.setAttribute('aria-label', 'Menu');
    actions.appendChild(menuToggle);

    // Dropdown menu (hidden by default)
    const dropdown = document.createElement('div');
    dropdown.className = 'menu-dropdown';
    dropdown.innerHTML = `
      <div class="dropdown-info">
        <span class="dropdown-info-label">${api.getUsername() || 'Unknown'}</span>
        <span class="dropdown-info-url">${api.getBaseUrl() || 'No server'}</span>
      </div>
      <button class="dropdown-item dropdown-item-respect">Copy RESPECT Link</button>
      <button class="dropdown-item dropdown-item-logout">Logout</button>
    `;
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

    // Logout action
    dropdown.querySelector('.dropdown-item-logout').addEventListener('click', () => {
      dropdown.classList.remove('open');
      this.logout();
    });
 
    // Copy RESPECT Link action
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
  renderLoginStep1(pushHistory = true) {
    this.removeMenuBar();
    const container = document.getElementById('page-container');
    container.innerHTML = `
      <div class="screen" id="login-step1">
        <div class="card">
          <img src="img/logo-login.png" alt="Tangerine" class="login-logo">
          <h1>Enter your server URL</h1>
          <input type="text" id="server-url" placeholder="https://your-server.com" value="${api.getBaseUrl()}">
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
  },

  renderLoginStep2(pushHistory = true) {
    this.removeMenuBar();
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
          <input type="text" id="username" placeholder="Username" autocomplete="username">
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
  },

  async renderGroups() {
    // Push browser history entry so back button fires popstate
    if (this._history.length === 0) {
      history.pushState({ page: 'groups' }, '');
    }
    const container = document.getElementById('page-container');
    container.innerHTML = `<div class="screen" id="groups"><h1>Groups</h1><ul id="group-list"></ul></div>`;
    this.renderMenuBar('Groups');
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
        dlBtn.title = 'Cache all forms in this group for offline use';
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
    this.renderMenuBar(`Forms - ${groupName}`);
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
        const formUrl = `${api.getBaseUrl()}/releases/prod/online-survey-apps/${groupId}/${formId}/#/form/${formId}`;
        console.log('[VIEWS] Processing form:', { formName, formId, formUrl, raw: form });
        const li = document.createElement('li');
        li.className = 'list-item';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'list-item-name';
        nameSpan.textContent = formName;
        li.appendChild(nameSpan);

        const dlBtn = document.createElement('button');
        dlBtn.className = 'download-btn';
        dlBtn.title = 'Cache this form for offline use';
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

  openFormInWebView(url) {
    if (!url) {
      alert('No URL available for this form.');
      return;
    }
    // Use Capacitor InAppBrowser plugin for embedded WebView (inside app, no CORS)
    const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
    try {
      if (isNative && window.Capacitor.Plugins.InAppBrowser) {
        console.log('[VIEWS] Opening form in embedded WebView:', url);
        window.Capacitor.Plugins.InAppBrowser.openInWebView({
          url: url,
          options: {
            showToolbar: true,
            showURL: false,
            closeButtonText: 'Close',
            toolbarPosition: 0, // TOP
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
          }
        }).catch(err => {
          console.error('[VIEWS] InAppBrowser openInWebView failed:', err);
          alert('Failed to open form: ' + (err.message || 'Unknown error'));
        });
      } else if (isNative) {
        console.error('[VIEWS] InAppBrowser plugin not available on native platform');
        alert('InAppBrowser plugin is not available. Please ensure @capacitor/inappbrowser is installed.');
      } else {
        // In a browser, open in a new tab
        const win = window.open(url, '_blank');
        if (!win) {
          console.warn('[VIEWS] Popup blocked, offering fallback');
          alert('A popup blocker prevented opening the form. Please allow popups for this site, or use this link:\n\n' + url);
        }
      }
    } catch (e) {
      console.error('[VIEWS] Error opening form:', e);
      alert('Could not open form. Please try again.\n\n' + url);
    }
  },

  /**
   * Cache a single form's resources for offline use.
   * Fetches the form page, parses it for sub-resources (CSS, JS, images),
   * and downloads them all through the cache service.
   */
  async cacheFormResources(formUrl, buttonEl) {
    const cacheKey = 'form:' + formUrl;
    buttonEl.textContent = '⏳';
    buttonEl.disabled = true;
    buttonEl.style.opacity = '0.7';
    buttonEl.style.borderColor = '';
    buttonEl.style.color = '';

    try {
      const baseUrl = formUrl.replace(/#.*$/, '');
      const urlsToCache = [baseUrl];

      // Fetch the form page to discover sub-resources
      try {
        const response = await httpClient.get(baseUrl, {
          'Authorization': localStorage.getItem('token')
        });
        if (response.ok) {
          const html = await response.text();
          const resourceUrls = this._extractResourceUrls(html, baseUrl);
          urlsToCache.push(...resourceUrls);
        }
      } catch (e) {
        console.warn('[VIEWS] Could not fetch form page for resource discovery:', e);
      }

      console.log('[VIEWS] Caching form resources:', urlsToCache);
      await cacheService.downloadAndRetain(
        urlsToCache.map(url => ({ url, remark: 'form-cache' }))
      );

      this._markCached(cacheKey);
      this._setDownloadBtnCached(buttonEl);
    } catch (err) {
      console.error('[VIEWS] Failed to cache form:', err);
      buttonEl.textContent = '✗';
      buttonEl.style.color = '#e74c3c';
      buttonEl.style.borderColor = '';
      setTimeout(() => {
        buttonEl.textContent = '⬇';
        buttonEl.style.color = '';
        buttonEl.disabled = false;
        buttonEl.style.opacity = '1';
      }, 2000);
    }
  },

  /**
   * Cache all forms in a group for offline use.
   */
  async cacheGroupResources(groupId, buttonEl) {
    const cacheKey = 'group:' + groupId;
    buttonEl.textContent = '⏳';
    buttonEl.disabled = true;
    buttonEl.style.opacity = '0.7';
    buttonEl.style.borderColor = '';
    buttonEl.style.color = '';

    try {
      const forms = await api.getFormsForGroup(groupId);
      console.log('[VIEWS] Caching group forms:', forms.length);

      const allUrls = [];
      for (const form of forms) {
        const formId = form.id;
        const formUrl = `${api.getBaseUrl()}/releases/prod/online-survey-apps/${groupId}/${formId}/#/form/${formId}`;
        const baseUrl = formUrl.replace(/#.*$/, '');
        allUrls.push(baseUrl);

        // Discover sub-resources from each form
        try {
          const response = await httpClient.get(baseUrl, {
            'Authorization': localStorage.getItem('token')
          });
          if (response.ok) {
            const html = await response.text();
            const resourceUrls = this._extractResourceUrls(html, baseUrl);
            allUrls.push(...resourceUrls);
          }
        } catch (e) {
          console.warn(`[VIEWS] Could not fetch form ${formId} for resource discovery:`, e);
        }

        // Mark each form as cached so its ✓ shows in the form list
        this._markCached('form:' + formUrl);
      }

      // Deduplicate
      const uniqueUrls = [...new Set(allUrls)];
      console.log('[VIEWS] Caching group resources:', uniqueUrls.length, 'URLs');
      await cacheService.downloadAndRetain(
        uniqueUrls.map(url => ({ url, remark: 'group-cache' }))
      );

      this._markCached(cacheKey);
      this._setDownloadBtnCached(buttonEl);
    } catch (err) {
      console.error('[VIEWS] Failed to cache group:', err);
      buttonEl.textContent = '✗';
      buttonEl.style.color = '#e74c3c';
      buttonEl.style.borderColor = '';
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
   * Resolves relative URLs against the given base URL.
   */
  _extractResourceUrls(html, baseUrl) {
    const urls = [];
    // Match link href (CSS, icons)
    const linkRegex = /<link[^>]+href=["']([^"']+)["']/gi;
    let match;
    while ((match = linkRegex.exec(html)) !== null) {
      urls.push(this._resolveUrl(match[1], baseUrl));
    }
    // Match script src (JS)
    const scriptRegex = /<script[^>]+src=["']([^"']+)["']/gi;
    while ((match = scriptRegex.exec(html)) !== null) {
      urls.push(this._resolveUrl(match[1], baseUrl));
    }
    // Match img src
    const imgRegex = /<img[^>]+src=["']([^"']+)["']/gi;
    while ((match = imgRegex.exec(html)) !== null) {
      urls.push(this._resolveUrl(match[1], baseUrl));
    }
    return urls;
  },

  /**
   * Resolve a potentially relative URL against a base URL.
   */
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