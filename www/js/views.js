// View management
const views = {
  _history: [],
  _currentGroupId: null,
  _currentGroupName: null,

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

    // Logout button
    const logoutBtn = document.createElement('button');
    logoutBtn.className = 'menu-btn menu-btn-logout';
    logoutBtn.textContent = 'Logout';
    logoutBtn.addEventListener('click', () => this.logout());
    actions.appendChild(logoutBtn);

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

      groups.forEach(group => {
        // The Tangerine API returns groups with attributes: { attributes: { name: '<uuid>', label: '...', roles: [...] } }
        const groupId = group.attributes ? group.attributes.name : (group.id || group.name);
        const displayName = (group.attributes && group.attributes.label) || (group.attributes && group.attributes.name) || groupId;
        console.log('[VIEWS] Processing group:', { groupId, displayName, raw: JSON.stringify(group) });
        const li = document.createElement('li');
        li.textContent = displayName;
        li.dataset.groupId = groupId;
        li.classList.add('clickable');
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
      forms.forEach(form => {
        const formName = form.title || form.name || form.id || 'Unnamed Form';
        const formId = form.id;
        const formUrl = `${api.getBaseUrl()}/releases/prod/online-survey-apps/${groupId}/${formId}/#/form/${formId}`;
        console.log('[VIEWS] Processing form:', { formName, formId, formUrl, raw: form });
        const li = document.createElement('li');
        li.textContent = formName;
        li.dataset.formUrl = formUrl;
        li.classList.add('clickable');
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