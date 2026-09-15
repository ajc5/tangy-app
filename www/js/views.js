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

  // Ask the native TangyCache whether a URL is actually stored on disk.
  async _urlIsCached(url) {
    const plugin = window.Capacitor?.Plugins?.TangyCache;
    if (plugin && plugin.isCached) {
      try {
        const result = await plugin.isCached({ url });
        return !!result.cached;
      } catch (e) {
        console.warn('[VIEWS] isCached failed:', e);
      }
    }
    return false;
  },

  _setDownloadBtnCached(buttonEl) {
    this._clearDownloadBusy(buttonEl);
    buttonEl.removeAttribute('aria-busy');
    // The visible check is an SVG-free text node, so the button needs an
    // explicit accessible name (RESPECT labels this state "Downloaded").
    // Maestro matches this label, which is stabler than matching a glyph.
    buttonEl.setAttribute('aria-label', 'Downloaded');
    // The check stays real text so it remains legible at small sizes; the
    // tinted disc is presentational only.
    buttonEl.innerHTML = '<span class="dl-cached">✓</span>';
    buttonEl.style.color = '#4caf50';
    buttonEl.style.borderColor = '';
    buttonEl.disabled = false;
    buttonEl.style.opacity = '1';
  },

  _setDownloadBtnUncached(buttonEl) {
    this._clearDownloadBusy(buttonEl);
    buttonEl.removeAttribute('aria-busy');
    // RESPECT renders Icons.Default.FileDownload here (arrow onto a bar), not a
    // bare down-arrow, so the two apps show the same affordance.
    buttonEl.innerHTML = this._icon('download', 'download-icon');
    buttonEl.setAttribute('aria-label', 'Download');
    buttonEl.style.color = '';
    buttonEl.style.borderColor = '';
    buttonEl.disabled = false;
    buttonEl.style.opacity = '1';
  },

  /**
   * Drop the busy bookkeeping, so the next tap starts a fresh download instead
   * of being read as a cancel of a job that has already finished.
   */
  _clearDownloadBusy(buttonEl) {
    if (!buttonEl) return;
    buttonEl._dlBusy = false;
    buttonEl._dlSignal = null;
  },

  /**
   * Busy state: a circular progress ring drawn over the download arrow,
   * mirroring the RESPECT app's RespectOfflineItemStatusIcon. With no argument
   * the ring spins (indeterminate, used while resources are still being
   * discovered); pass `progress` (0..1) for a determinate arc.
   *
   * The button stays ENABLED on purpose: RESPECT labels this state "Cancel",
   * so a tap aborts the job rather than being silently swallowed.
   */
  _setDownloadBtnBusy(buttonEl, progress) {
    if (!buttonEl) return;
    if (buttonEl._dlBusy) {
      // Already rendering — just move the arc. Rebuilding innerHTML for each of
      // a group's ~140 URLs would thrash layout in the list row.
      this._updateDownloadRing(buttonEl, progress);
      return;
    }
    buttonEl._dlBusy = true;
    buttonEl.disabled = false;
    buttonEl.style.opacity = '0.7';
    buttonEl.innerHTML = this._downloadProgressMarkup(progress);
    buttonEl.setAttribute('aria-label', 'Downloading, tap to cancel');
    buttonEl.setAttribute('aria-busy', 'true');
  },

  _updateDownloadRing(buttonEl, progress) {
    const ringEl = buttonEl.querySelector('.dl-progress-ring');
    const svgEl = buttonEl.querySelector('.dl-progress-ring-svg');
    if (!ringEl || !svgEl) return;
    const { dash, gap, determinate } = this._downloadRingDash(progress);
    ringEl.setAttribute('stroke-dasharray', dash);
    ringEl.setAttribute('stroke-dashoffset', gap);
    svgEl.classList.toggle('is-indeterminate', !determinate);
  },

  /** Shared arc geometry, so the first render and later updates agree. */
  _downloadRingDash(progress) {
    const circumference = 2 * Math.PI * 10.5;   // r=10.5 inside a 24x24 viewBox
    const determinate = typeof progress === 'number' && isFinite(progress);
    if (!determinate) {
      // A short arc chasing itself around the ring.
      return {
        dash: (circumference * 0.28).toFixed(2),
        gap: circumference.toFixed(2),
        determinate: false,
      };
    }
    const clamped = Math.min(Math.max(progress, 0), 1);
    return {
      dash: circumference.toFixed(2),
      gap: (circumference * (1 - clamped)).toFixed(2),
      determinate: true,
    };
  },

  _downloadProgressMarkup(progress) {
    const { dash, gap, determinate } = this._downloadRingDash(progress);
    return '<span class="dl-progress">' +
      '<svg class="dl-progress-ring-svg' + (determinate ? '' : ' is-indeterminate') + '" viewBox="0 0 24 24" aria-hidden="true">' +
        '<circle class="dl-progress-ring" cx="12" cy="12" r="10.5" ' +
          'stroke-dasharray="' + dash + '" stroke-dashoffset="' + gap + '"/>' +
      '</svg>' +
      '<svg class="dl-progress-arrow" viewBox="0 0 24 24" aria-hidden="true">' +
        '<path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>' +
      '</svg>' +
    '</span>';
  },

  /**
   * Single entry point for a download button tap: start a job, or cancel the
   * one already running on that button. Keeps one listener per element, so a
   * cancel can never also kick off a new download.
   */
  _onDownloadBtnClick(buttonEl, startFn) {
    if (buttonEl._dlBusy) {
      this._cancelDownload(buttonEl);
      return;
    }
    startFn();
  },

  /**
   * Abort the in-flight job for this button. Cooperative: the running loop
   * checks `signal.cancelled` between requests (see CacheService). Whatever
   * already landed on disk stays there — it is only a cache — but nothing is
   * marked as pinned, so the next tap re-runs the job cleanly.
   */
  _cancelDownload(buttonEl) {
    const signal = buttonEl._dlSignal;
    if (!signal || signal.cancelled) return;
    signal.cancelled = true;
    console.log('[VIEWS] Download cancelled by user');
    buttonEl.disabled = true;                 // one cancel per job
    buttonEl.setAttribute('aria-label', 'Cancelling download');
    buttonEl.setAttribute('aria-busy', 'true');
    // Keep the ring moving until the in-flight request settles.
    buttonEl.innerHTML = this._downloadProgressMarkup();
  },

  // After the form list renders, flip a form's download icon to ✓ when the native cache
  // actually holds the form's shell URL. This makes the badge reflect content
  // that was ADOPTED from the RESPECT launcher's cache (either served during a
  // RESPECT-launched session or during an offline direct open), not only items
  // explicitly pinned here. It also re-marks items that were previously pinned
  // so the badge stays correct across sessions.
  async _reconcileFormBadge(buttonEl, formUrl, groupId) {
    try {
      const formKey = 'form:' + formUrl;
      if (this._isCached(formKey) || this._isCached('group:' + groupId)) return;
      const baseUrl = formUrl.replace(/#.*$/, '');
      if (await this._urlIsCached(baseUrl)) {
        this._markCached(formKey);
        const existing = this._getPinnedUrls(formKey);
        if (!existing.includes(baseUrl)) {
          existing.push(baseUrl);
          this._savePinnedUrls(formKey, existing);
        }
        // This probe is async, so a download the user started in the meantime
        // may already own the button — never stomp its spinner or its cancel.
        if (buttonEl._dlBusy) return;
        this._setDownloadBtnCached(buttonEl);
        console.log('[VIEWS] Auto-marked form cached (found on disk):', formUrl);
      }
    } catch (e) {
      console.warn('[VIEWS] Badge reconcile failed:', e);
    }
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
   * Material Symbols paths (24x24 viewBox) for the header chrome — the same
   * glyphs the RESPECT app draws through Compose (Icons.AutoMirrored.Filled
   * .ArrowBack, Icons.Default.Menu, Icons.Filled.Close). Using the standard set
   * keeps the two apps' headers visually identical; the text glyphs they
   * replaced (← ☰) had inconsistent stroke weight and baseline.
   */
  _ICON_PATHS: {
    back: 'M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z',
    close: 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
    menu: 'M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z',
    // Material `file_download` (arrow onto a bar) - the glyph RESPECT shows for
    // a publication that is not pinned yet (Icons.Default.FileDownload). The
    // text glyph it replaced (⬇) was a thin down-arrow with no bar.
    download: 'M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z',
  },

  /** Inline SVG for an icon; colour comes from `fill: currentColor`. */
  _icon(name, className = 'menu-icon') {
    const path = this._ICON_PATHS[name];
    if (!path) return '';
    return '<svg class="' + className + '" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      '<path d="' + path + '"/></svg>';
  },

  /**
   * Copy `text` to the system clipboard, resolving true on success.
   *
   * The synchronous execCommand path is tried FIRST on purpose. Android WebView
   * refuses the async Clipboard API unless the host app grants
   * RESOURCE_CLIPBOARD_WRITE from its WebChromeClient, which the Capacitor shell
   * does not - navigator.clipboard.writeText() rejects with
   * "NotAllowedError: Write permission denied". execCommand('copy') needs the
   * click's transient user activation, so it must run inside the event handler
   * rather than in a promise catch, where the activation may already have
   * expired.
   */
  _copyTextToClipboard(text) {
    const legacyOk = this._legacyCopyText(text);
    if (legacyOk) return Promise.resolve(true);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(() => true).catch(() => false);
    }
    return Promise.resolve(false);
  },

  /** Synchronous clipboard write; returns whether the browser reported success. */
  _legacyCopyText(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    // Offscreen but still selectable - display:none cannot be selected.
    ta.style.cssText = 'position:fixed;top:-1000px;left:0;opacity:0;';
    document.body.appendChild(ta);
    let ok = false;
    try {
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      ok = document.execCommand('copy');
    } catch (e) {
      ok = false;
    }
    document.body.removeChild(ta);
    return ok;
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
      backBtn.innerHTML = this._icon('back');
      // The glyph is an SVG now, so its accessible name has to be explicit.
      backBtn.setAttribute('aria-label', 'Back');
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
    menuToggle.innerHTML = this._icon('menu');
    menuToggle.setAttribute('aria-label', 'Menu');
    actions.appendChild(menuToggle);

    const dropdown = document.createElement('div');
    dropdown.className = 'menu-dropdown';

    if (loginMode) {
      // Login screen: only "Clear Login History" is available.
      dropdown.innerHTML = `
        <div class="dropdown-info">
          <span class="dropdown-info-label">Login</span>
          <span class="dropdown-info-url">${api.getBaseUrl() ? 'Server: ' + api.getBaseUrl() : 'No server selected'}</span>
        </div>
        <button class="dropdown-item dropdown-item-clear">Clear Login History</button>
      `;
      dropdown.querySelector('.dropdown-item-clear').addEventListener('click', () => {
        dropdown.classList.remove('open');
        this.clearLoginHistory();
      });
    } else {
      // Logged-in screen: RESPECT link, Clear Login History, Logout.
      dropdown.innerHTML = `
        <div class="dropdown-info">
          <span class="dropdown-info-label">${api.getUsername() || 'Unknown'}</span>
          <span class="dropdown-info-url">${api.getBaseUrl() || 'No server'}</span>
        </div>
        <button class="dropdown-item dropdown-item-respect">Copy RESPECT Link</button>
        <button class="dropdown-item dropdown-item-clear">Clear Login History</button>
        <button class="dropdown-item dropdown-item-logout">Logout</button>
      `;
      dropdown.querySelector('.dropdown-item-logout').addEventListener('click', () => {
        dropdown.classList.remove('open');
        this.logout();
      });
      dropdown.querySelector('.dropdown-item-clear').addEventListener('click', () => {
        dropdown.classList.remove('open');
        this.clearLoginHistory();
      });
      dropdown.querySelector('.dropdown-item-respect').addEventListener('click', () => {
        const link = api.getRespectUrl();
        if (!link) {
          alert('No RESPECT URL available. Please log in again.');
          return;
        }
        const btn = dropdown.querySelector('.dropdown-item-respect');
        const origText = btn.textContent;
        // Deliberately do NOT close the menu first: the feedback lives on this
        // button, and closing left it inside a display:none container where the
        // user could never see it.
        this._copyTextToClipboard(link).then((ok) => {
          btn.textContent = ok ? '✓ Copied!' : '✗ Copy failed';
          setTimeout(() => {
            btn.textContent = origText;
            dropdown.classList.remove('open');
          }, 1200);
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
    // The history unwind below fires popstate while the group list is still in
    // the DOM. Without this guard the popstate handler treats it as a hardware
    // back press on the groups page and asks the user to confirm the logout
    // they just chose.
    this._suppressBackLogoutPrompt = true;
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
      // Keep the guard up until the programmatic unwind has settled.
      setTimeout(() => {
        this._suppressBackLogoutPrompt = false;
      }, 250);
      return;
    }
    if (serverUrl) {
      this.renderLoginStep2();
    } else {
      this.renderLoginStep1();
    }
    this._suppressBackLogoutPrompt = false;
  },

  /**
   * Clear ONLY the recent login history (the saved servers/usernames offered
   * as suggestions on the login screens). The current session is untouched:
   * if you're logged in you stay logged in and remain on the current screen.
   * Invoked from the burger menu on any screen.
   */
  clearLoginHistory() {
    if (!confirm('Clear saved login history?\n\nThis will remove recent servers and usernames from this device. Your current login is not affected.')) {
      return;
    }
    api.clearLoginHistory();
    // Refresh whichever login step is shown so the cleared suggestions
    // disappear. On logged-in screens (groups/forms) there is no visible
    // recent-logins UI, so nothing needs re-rendering and the session
    // stays intact.
    if (document.getElementById('server-url')) {
      this.renderLoginStep1(false);
    } else if (document.getElementById('username')) {
      this.renderLoginStep2(false);
    }
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

  async renderGroups({ skipHistory = false } = {}) {
    // Push browser history entry so back button fires popstate
    if (!skipHistory && this._history.length === 0) {
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
        dlBtn.id = 'download-group-' + groupId;
        dlBtn.title = 'Pin all forms in this group for offline use';
        if (this._isCached('group:' + groupId)) {
          this._setDownloadBtnCached(dlBtn);
        } else {
          this._setDownloadBtnUncached(dlBtn);
        }
        dlBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this._onDownloadBtnClick(dlBtn, () => this.cacheGroupResources(groupId, dlBtn));
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
        dlBtn.id = 'download-form-' + formId;
        dlBtn.title = 'Pin this form for offline use';
        if (this._isCached('form:' + formUrl) || this._isCached('group:' + groupId)) {
          this._setDownloadBtnCached(dlBtn);
        } else {
          this._setDownloadBtnUncached(dlBtn);
        }
        dlBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this._onDownloadBtnClick(dlBtn, () => this.cacheFormResources(formUrl, dlBtn));
        });
        li.appendChild(dlBtn);
        // Flip the download icon to ✓ if this form's shell is already on the native cache (e.g.
        // adopted from RESPECT). Fire-and-forget; resolves after a native probe.
        this._reconcileFormBadge(dlBtn, formUrl, groupId);

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
      this._setDownloadBtnBusy(buttonEl);
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

    // Spins while resources are discovered, then tracks cached/total. The
    // signal lets a tap on the button abort the whole job.
    const signal = { cancelled: false };
    buttonEl._dlSignal = signal;
    this._setDownloadBtnBusy(buttonEl);

    try {
      const baseUrl = formUrl.replace(/#.*$/, '');
      const urlsToCache = await this._discoverAllFormResourceUrls(formUrl, baseUrl);
      console.log('[VIEWS] Pinning form resources via TangyCache:', urlsToCache.length, 'URLs');
      const result = await cacheService.downloadAndRetain(
        urlsToCache.map(url => ({ url, remark: 'form-cache' })),
        (done, total) => this._setDownloadBtnBusy(buttonEl, total ? done / total : 0),
        signal
      );
      console.log('[VIEWS] Pin result:', result.cached, 'cached,', result.failed, 'failed');

      if (result.cancelled) {
        console.log('[VIEWS] Form pin cancelled; nothing marked as cached.');
        this._setDownloadBtnUncached(buttonEl);
        return;
      }
      // Only mark the form cached when content actually landed on disk.
      // A false tick on failure (e.g. offline) would ALSO make the next
      // connected tap UNCACHE instead of cache (this button is a toggle).
      const baseCached = (await this._urlIsCached(baseUrl)) || result.urls.includes(baseUrl);
      if (result.cached > 0 && baseCached) {
        this._markCached(cacheKey);
        this._savePinnedUrls(cacheKey, result.urls);
        this._setDownloadBtnCached(buttonEl);
      } else {
        console.warn('[VIEWS] Pin did not cache anything (offline?); leaving uncached.');
        this._setDownloadBtnUncached(buttonEl);
        alert('Could not cache this form for offline use. Check your connection and try again.');
      }
    } catch (err) {
      console.error('[VIEWS] Failed to pin form:', err);
      this._setDownloadBtnUncached(buttonEl);
      alert('Could not cache this form for offline use: ' + ((err && err.message) || err));
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
      // Eviction is a single native call, so there is no signal to cancel with;
      // _cancelDownload no-ops and taps are ignored while _dlBusy is set.
      this._setDownloadBtnBusy(buttonEl);
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

    // Spins while each form's resources are discovered (the slow phase for a
    // group), then tracks cached/total across the whole flattened URL set.
    const signal = { cancelled: false };
    buttonEl._dlSignal = signal;
    this._setDownloadBtnBusy(buttonEl);

    try {
      const forms = await api.getFormsForGroup(groupId);
      console.log('[VIEWS] Pinning group forms:', forms.length);

      const allUrls = [];
      const childFormKeys = [];
      for (const form of forms) {
        if (signal.cancelled) {
          console.log('[VIEWS] Group pin cancelled during discovery.');
          this._setDownloadBtnUncached(buttonEl);
          return;
        }
        const formId = form.id;
        const formUrl = form._openAccessUrl
          ? (form._openAccessUrl.startsWith('http')
              ? form._openAccessUrl
              : `${api.getBaseUrl()}${form._openAccessUrl}`)
          : `${api.getBaseUrl()}/releases/prod/online-survey-apps/${groupId}/${formId}/#/form/${formId}`;
        const baseUrl = formUrl.replace(/#.*$/, '');

        // Use the SAME discovery that cacheFormResources uses. Crawling the
        // release shell alone is NOT enough: the form player fetches its own
        // assets/form/form.html, app-config.json, translations.json, icon fonts
        // etc. at runtime, so a group pinned that way cannot actually be opened
        // offline. _discoverAllFormResourceUrls prefers the server's OPDS
        // publication detail, which lists the full resource set (~141 URLs for a
        // typical form), and always includes baseUrl itself.
        try {
          const resourceUrls = await this._discoverAllFormResourceUrls(formUrl, baseUrl);
          allUrls.push(...resourceUrls);
          console.log(`[VIEWS] Discovered ${resourceUrls.length} resources for form ${formId}`);
        } catch (e) {
          console.warn(`[VIEWS] Resource discovery failed for form ${formId}; pinning the shell only:`, e);
          allUrls.push(baseUrl);
        }

        // Only recorded here; the key is MARKED cached further down, once the
        // download has actually succeeded. Marking it here would leave every
        // form row showing a cached badge for a group job that was cancelled
        // or that failed halfway.
        childFormKeys.push('form:' + formUrl);
      }

      const uniqueUrls = [...new Set(allUrls)];
      console.log('[VIEWS] Pinning group resources via Respect:', uniqueUrls.length, 'URLs');
      const result = await cacheService.downloadAndRetain(
        uniqueUrls.map(url => ({ url, remark: 'group-cache' })),
        (done, total) => this._setDownloadBtnBusy(buttonEl, total ? done / total : 0),
        signal
      );
      console.log('[VIEWS] Pin result:', result.cached, 'cached,', result.failed, 'failed');

      if (result.cancelled) {
        console.log('[VIEWS] Group pin cancelled; nothing marked as cached.');
        this._setDownloadBtnUncached(buttonEl);
        return;
      }

      childFormKeys.forEach(k => this._markCached(k));
      this._markCached(cacheKey);
      this._savePinnedUrls(cacheKey, result.urls);
      this._saveGroupFormKeys(groupId, childFormKeys);
      this._setDownloadBtnCached(buttonEl);
    } catch (err) {
      console.error('[VIEWS] Failed to pin group:', err);
      this._clearDownloadBusy(buttonEl);
      buttonEl.textContent = '✗';
      buttonEl.style.color = '#ff0000';
      buttonEl.setAttribute('aria-label', 'Download failed');
      buttonEl.removeAttribute('aria-busy');
      setTimeout(() => {
        this._setDownloadBtnUncached(buttonEl);
      }, 2000);
    }
  },

  /**
   * Gather every URL that must be cached for a form to open OFFLINE.
   * Preferred source: the server's OPDS publication detail (the full `resources`
   * array the server publishes for the form - app shell, app-config, tangy-form,
   * media) which is the same set the RESPECT launcher pre-caches. Falls back to
   * crawling the HTML shell for directly referenced assets.
   */
  async _discoverAllFormResourceUrls(formUrl, baseUrl) {
    const urls = [baseUrl];
    const releaseMatch = formUrl.match(/\/releases\/prod\/online-survey-apps\/([^/]+)\/([^/]+)\//);
    if (releaseMatch) {
      const groupId = releaseMatch[1];
      const formId = releaseMatch[2];
      const token = (api._getRespectToken ? api._getRespectToken() : '') || '';
      const detailUrl = `${api.getBaseUrl()}/opds/groups/${groupId}/${formId}` +
        (token ? `?respectToken=${token}` : '');
      try {
        const resp = await httpClient.get(detailUrl, { 'Authorization': localStorage.getItem('token') });
        if (resp.ok) {
          const resourceUrls = this._extractReadiumResources(await resp.text(), baseUrl);
          if (resourceUrls.length > 0) {
            console.log('[VIEWS] OPDS detail provided', resourceUrls.length, 'resources');
            return [...new Set(urls.concat(resourceUrls))];
          }
        } else {
          console.warn('[VIEWS] OPDS detail fetch status', resp.status);
        }
      } catch (e) {
        console.warn('[VIEWS] OPDS detail fetch failed, falling back to HTML crawl:', e.message);
      }
    }
    // Fallback: crawl the HTML shell for directly referenced assets.
    try {
      const response = await httpClient.get(baseUrl, { 'Authorization': localStorage.getItem('token') });
      if (response.ok) {
        const text = await response.text();
        const ct = response.headers.get('content-type') || '';
        if (ct.includes('/json') || ct.includes('opds') || text.trim().startsWith('{')) {
          urls.push(...this._extractReadiumResources(text, baseUrl));
        } else {
          urls.push(...this._extractResourceUrls(text, baseUrl));
        }
      }
    } catch (e) {
      console.warn('[VIEWS] Could not fetch form page for resource discovery:', e);
    }
    return [...new Set(urls)];
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
      } else if (!this._suppressBackLogoutPrompt && document.getElementById('group-list')) {
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