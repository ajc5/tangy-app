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

    const titleEl = document.createElement('span');
    titleEl.className = 'menu-title';
    titleEl.textContent = title || 'Tangerine Data Collector';
    menuBar.appendChild(titleEl);

    const actions = document.createElement('div');
    actions.className = 'menu-actions';

    // Home button
    const homeBtn = document.createElement('button');
    homeBtn.className = 'menu-btn';
    homeBtn.textContent = 'Home';
    homeBtn.addEventListener('click', () => this.goHome());
    actions.appendChild(homeBtn);

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
    if (serverUrl) {
      this.renderLoginStep2();
    } else {
      this.renderLoginStep1();
    }
  },
  renderLoginStep1() {
    this.removeMenuBar();
    const container = document.getElementById('page-container');
    container.innerHTML = `
      <div class="screen" id="login-step1">
        <div class="card">
          <h1>Connect to a Tangerine Server</h1>
          <input type="text" id="server-url" placeholder="https://your-server.com" value="${api.getBaseUrl()}">
          <button id="connect-btn">Connect</button>
          <div id="step1-error" class="error"></div>
        </div>
      </div>
    `;
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

  renderLoginStep2() {
    this.removeMenuBar();
    const container = document.getElementById('page-container');
    const serverUrl = api.getBaseUrl();
    container.innerHTML = `
      <div class="screen" id="login-step2">
        <div class="card">
          <div class="server-info">
            <label>Server:</label>
            <span id="server-display">${serverUrl}</span>
            <button id="change-server-btn" class="link-btn">Change</button>
          </div>
          <h1>Tangerine</h1>
          <form id="login-form">
          <input type="text" id="username" placeholder="Username" autocomplete="username">
          <input type="password" id="password" placeholder="Password" autocomplete="current-password">
            <button type="submit" id="login-btn">Login</button>
          </form>
          <div id="step2-error" class="error"></div>
      </div>
      </div>
    `;
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
    const container = document.getElementById('page-container');
    container.innerHTML = `<div class="screen" id="groups"><h1>Your Groups</h1><ul id="group-list"></ul></div>`;
    this.renderMenuBar('Your Groups');
    const list = document.getElementById('group-list');
    try {
      const groups = await api.getGroups();
      console.log('[VIEWS] renderGroups received:', groups);
      groups.forEach(group => {
        // The Tangerine API returns groups with attributes: { attributes: { name: '...', roles: [...] } }
        const groupId = group.attributes ? group.attributes.name : (group.id || group.name);
        const groupName = group.attributes ? group.attributes.name : (group.name || group.id || 'Unknown');
        console.log('[VIEWS] Processing group:', { groupId, groupName, raw: group });
        const li = document.createElement('li');
        li.textContent = groupName;
        li.dataset.groupId = groupId;
        li.classList.add('clickable');
        li.addEventListener('click', () => {
          this._history.push('groups');
          this._currentGroupId = groupId;
          this._currentGroupName = groupName;
          this.renderForms(groupId, groupName);
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
    try {
      if (Capacitor.isNativePlatform()) {
        console.log('[VIEWS] Opening form in embedded WebView:', url);
        Capacitor.Plugins.InAppBrowser.openInWebView({
          url: url,
          options: {
            showToolbar: true,
            showURL: true,
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
        });
      } else {
        window.open(url, '_blank');
      }
    } catch (e) {
      console.warn('[VIEWS] InAppBrowser not available, opening in external browser:', e);
      window.open(url, '_blank');
    }
  },

  init() {
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
  }
};