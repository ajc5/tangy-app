/**
 * Lightweight i18n for all user-facing strings.
 *
 * Supports multiple languages via the `locales` registry below. The active
 * language is persisted in localStorage ('appLocale') and restored on load.
 *
 * Usage:
 *   t('menu.clearLoginHistory')                    // simple lookup
 *   t('pages.formsTitle', { groupName: 'Group A' }) // {placeholder} interpolation
 *   I18N.setLocale('fr')                            // switch language at runtime
 *
 * Missing keys fall back to English, then to the raw key itself.
 */
const I18N = {
  current: 'en',
  locales: {
    en: {
      dir: 'ltr',
      common: {
        demo: ' (demo)',
        close: 'Close',
      },
      menu: {
        toggleLabel: 'Menu',
        language: 'Language',
        back: 'Back',
        switchDirection: 'Switch Language Direction',
        direction: 'Direction',
        ltr: 'LTR',
        rtl: 'RTL',
        loginLabel: 'Login',
        serverPrefix: 'Server: ',
        noServerSelected: 'No server selected',
        clearLoginHistory: 'Clear Login History',
        unknownUser: 'Unknown',
        noServer: 'No server',
        copyRespect: 'Copy RESPECT Link',
        logout: 'Logout',
        noRespectUrl: 'No RESPECT URL available. Please log in again.',
        copied: '✓ Copied!',
      },
      login: {
        serverTitle: 'Enter your server URL',
        serverPlaceholder: 'https://your-server.com',
        connect: 'Connect',
        serverLabel: 'Server:',
        change: 'Change',
        usernamePlaceholder: 'Username',
        passwordPlaceholder: 'Password',
        login: 'Login',
      },
      pages: {
        groups: 'Groups',
        formsTitle: 'Forms - {groupName}',
        unnamedForm: 'Unnamed Form',
        pinGroup: 'Pin all forms in this group for offline use',
        pinForm: 'Pin this form for offline use',
      },
      errors: {
        serverRequired: 'Please enter a server URL.',
        fillAll: 'Please fill in all fields.',
        noGroups: 'No groups found',
        noForms: 'No forms found for this group',
      },
      alerts: {
        noUrl: 'No URL available for this form.',
        noBrowserPlugin: 'No browser plugin available.',
        popupBlocked: 'Popup blocked. Please allow popups for:\n\n',
        couldNotOpen: 'Could not open form:\n\n',
        cannotOpen: 'Cannot open form: no browser available.',
        failedToOpen: 'Failed to open form: ',
        unknownError: 'Unknown error',
      },
      refresh: {
        updatingOne: 'Updating {count} cached form…',
        updatingMany: 'Updating {count} cached forms…',
        updated: '✓ Cached forms updated to latest version',
        failed: '↷ Could not refresh — cached forms kept as-is',
      },
      confirm: {
        clearLoginHistory: 'Clear login history?\n\nThis will remove stored login history and log you out.',
        logout: 'Log out and return to the login screen?',
      },
    },

    fr: {
      dir: 'ltr',
      common: {
        demo: ' (démo)',
        close: 'Fermer',
      },
      menu: {
        toggleLabel: 'Menu',
        language: 'Langue',
        back: 'Retour',
        switchDirection: 'Inverser le sens de la langue',
        direction: 'Direction',
        ltr: 'LTR',
        rtl: 'RTL',
        loginLabel: 'Connexion',
        serverPrefix: 'Serveur : ',
        noServerSelected: 'Aucun serveur sélectionné',
        clearLoginHistory: 'Effacer l\u2019historique de connexion',
        unknownUser: 'Inconnu',
        noServer: 'Aucun serveur',
        copyRespect: 'Copier le lien RESPECT',
        logout: 'Déconnexion',
        noRespectUrl: 'Aucune URL RESPECT disponible. Veuillez vous reconnecter.',
        copied: '✓ Copié !',
      },
      login: {
        serverTitle: 'Saisissez l\u2019URL du serveur',
        serverPlaceholder: 'https://votre-serveur.com',
        connect: 'Connecter',
        serverLabel: 'Serveur :',
        change: 'Modifier',
        usernamePlaceholder: 'Nom d\u2019utilisateur',
        passwordPlaceholder: 'Mot de passe',
        login: 'Connexion',
      },
      pages: {
        groups: 'Groupes',
        formsTitle: 'Formulaires - {groupName}',
        unnamedForm: 'Formulaire sans nom',
        pinGroup: 'Épingler tous les formulaires de ce groupe pour une utilisation hors ligne',
        pinForm: 'Épingler ce formulaire pour une utilisation hors ligne',
      },
      errors: {
        serverRequired: 'Veuillez saisir une URL de serveur.',
        fillAll: 'Veuillez remplir tous les champs.',
        noGroups: 'Aucun groupe trouvé',
        noForms: 'Aucun formulaire trouvé pour ce groupe',
      },
      alerts: {
        noUrl: 'Aucune URL disponible pour ce formulaire.',
        noBrowserPlugin: 'Aucun plugin navigateur disponible.',
        popupBlocked: 'Fenêtre bloquée. Veuillez autoriser les fenêtres contextuelles pour :\n\n',
        couldNotOpen: 'Impossible d\u2019ouvrir le formulaire :\n\n',
        cannotOpen: 'Impossible d\u2019ouvrir le formulaire : aucun navigateur disponible.',
        failedToOpen: 'Échec de l\u2019ouverture du formulaire : ',
        unknownError: 'Erreur inconnue',
      },
      refresh: {
        updatingOne: 'Mise à jour de {count} formulaire en cache…',
        updatingMany: 'Mise à jour de {count} formulaires en cache…',
        updated: '✓ Formulaires en cache mis à jour',
        failed: '↷ Actualisation impossible — formulaires en cache conservés tels quels',
      },
      confirm: {
        clearLoginHistory: 'Effacer l\u2019historique de connexion ?\n\nCela supprimera l\u2019historique de connexion enregistré et vous déconnectera.',
        logout: 'Se déconnecter et revenir à l\u2019écran de connexion ?',
      },
    },

    // Add additional languages by copying the structure above (e.g. es, sw).
  },

  nativeNames: {
    en: 'English',
    fr: 'Français',
  },

  getLanguages() {
    return Object.keys(this.locales).map((code) => ({
      code,
      name: this.nativeNames[code] || code,
    }));
  },

  // Apply a locale for this session only (does NOT persist). Used for the
  // device default and for the language sent by the Tangerine server on login.
  applyLocale(lang) {
    if (this.locales[lang]) {
      this.current = lang;
    } else {
      this.current = 'en';
    }
    this.applyToDocument();
    return this.current;
  },

  // Set locale from the user-facing picker: applies AND persists the choice.
  setLocale(lang) {
    this.applyLocale(lang);
    try {
      localStorage.setItem('appLocale', this.current);
    } catch (e) { /* ignore */ }
    return this.current;
  },

  getManualPreference() {
    try {
      return localStorage.getItem('appLocale') || null;
    } catch (e) { return null; }
  },

  // Best guess before the user's server-side language is known:
  // manual picker choice → device locale → English.
  resolveInitialLocale() {
    const manual = this.getManualPreference();
    if (manual && this.locales[manual]) return manual;
    return this.getDeviceLocale() || 'en';
  },

  // Read the device/WebView language (e.g. 'fr-FR' → 'fr') if supported.
  getDeviceLocale() {
    try {
      const langs = (navigator.languages && navigator.languages.length)
        ? navigator.languages
        : [navigator.language || ''];
      for (const l of langs) {
        const code = String(l).split('-')[0].toLowerCase();
        if (this.locales[code]) return code;
      }
    } catch (e) { /* ignore */ }
    return null;
  },

  getLocale() {
    return this.current;
  },

  // ── Text direction (RTL / LTR) ──

  // Default direction for a locale (from its `dir` field; defaults to ltr).
  getDefaultDir(lang) {
    const loc = this.locales[lang || this.current];
    return (loc && loc.dir) || 'ltr';
  },

  getManualDirection() {
    try {
      return localStorage.getItem('appDir') || null;
    } catch (e) { return null; }
  },

  // Active direction: manual override → current locale's default → ltr.
  getDir() {
    return this.getManualDirection() || this.getDefaultDir(this.current);
  },

  // Set an explicit LTR/RTL override (persisted) and apply it to the page.
  setDirection(dir) {
    if (dir !== 'rtl' && dir !== 'ltr') {
      dir = this.getDefaultDir(this.current);
    }
    try {
      localStorage.setItem('appDir', dir);
    } catch (e) { /* ignore */ }
    this.applyToDocument();
    return dir;
  },

  // Reflect the active locale + direction on <html> (lang + dir attributes).
  applyToDocument() {
    try {
      const root = document.documentElement;
      if (root) {
        root.setAttribute('lang', this.current);
        root.setAttribute('dir', this.getDir());
      }
    } catch (e) { /* ignore */ }
  },

  _resolve(key) {
    const parts = key.split('.');
    const lookup = (dict) => parts.reduce((o, k) => (o == null ? o : o[k]), dict);
    return lookup(this.locales[this.current]) ||
           lookup(this.locales.en) ||
           key;
  },

  _interpolate(str, vars) {
    if (!vars) return str;
    return str.replace(/\{(\w+)\}/g, (match, name) =>
      vars[name] != null ? vars[name] : match
    );
  },

  t(key, vars) {
    return this._interpolate(this._resolve(key), vars);
  },
};

/** Global translate helper (used by views.js and others). */
function t(key, vars) {
  return I18N.t(key, vars);
}

// Pick an initial language on load: manual choice → device locale → English.
(function initLocale() {
  try {
    I18N.current = I18N.resolveInitialLocale();
    I18N.applyToDocument();
  } catch (e) { /* ignore */ }
})();
