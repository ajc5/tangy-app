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
        demoServer: 'Demo Server',
        demoMode: 'DEMO MODE',
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
        about: 'About',
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
        checking: 'Checking server…',
        serverLabel: 'Server:',
        change: 'Change',
        usernamePlaceholder: 'Username',
        passwordPlaceholder: 'Password',
        login: 'Login',
      },
      pages: {
        groups: 'Groups',
        loadingGroups: 'Loading groups…',
        loadingForms: 'Loading forms…',
        formsTitle: 'Forms - {groupName}',
        unnamedForm: 'Unnamed Form',
        pinGroup: 'Download all forms in this group for offline use',
        pinForm: 'Download this form for offline use',
      },
      errors: {
        serverRequired: 'Please enter a server URL.',
        serverInvalidUrl: 'Please enter a valid URL, e.g. https://your-server.com.',
        serverNotTangerine: 'This URL is not a Tangerine server with app support. Please set it to the correct version of Tangerine.',
        serverUnreachable: 'Could not reach this server. Check the URL and your connection, then try again.',
        fillAll: 'Please fill in all fields.',
        sessionExpired: 'Your session expired. Please sign in again.',
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
        updatingOne: 'Updating {count} downloaded form…',
        updatingMany: 'Updating {count} downloaded forms…',
        updated: '✓ Downloaded forms updated to latest version',
        failed: '↷ Could not refresh — downloaded forms kept as-is',
      },
      sync: {
        upToDate: '✓ All downloaded forms are up to date',
        cancelling: 'Cancelling update…',
        cancelled: '↷ Update cancelled',
        progress: 'Updating {done} of {total}…',
        updated: '✓ Updated {count} downloaded form(s)',
        partial: 'Updated {updated}, {failed} failed',
        failed: '↷ Could not update — downloaded forms kept as-is',
        updateAvailable: 'Update available',
        staleTitle: 'A newer version is available on the server — tap to update',
        buttonTitle: 'Sync: upload responses and update downloaded forms',
        buttonBusy: 'Syncing — tap to cancel',
      },
      responses: {
        partial: 'Uploaded {updated}, {failed} could not be sent',
        failed: '↷ Could not upload responses — they are kept on this device',
      },
      about: {
        title: 'About',
        appName: 'Tangerine Data Collector',
        version: 'Version',
        server: 'Server',
        user: 'User',
        close: 'Close',
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
        demoServer: 'Serveur de démonstration',
        demoMode: 'MODE DÉMO',
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
        about: 'À propos',
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
        checking: 'Vérification du serveur…',
        serverLabel: 'Serveur :',
        change: 'Modifier',
        usernamePlaceholder: 'Nom d\u2019utilisateur',
        passwordPlaceholder: 'Mot de passe',
        login: 'Connexion',
      },
      pages: {
        groups: 'Groupes',
        loadingGroups: 'Chargement des groupes…',
        loadingForms: 'Chargement des formulaires…',
        formsTitle: 'Formulaires - {groupName}',
        unnamedForm: 'Formulaire sans nom',
        pinGroup: 'Télécharger tous les formulaires de ce groupe pour une utilisation hors ligne',
        pinForm: 'Télécharger ce formulaire pour une utilisation hors ligne',
      },
      errors: {
        serverRequired: 'Veuillez saisir une URL de serveur.',
        serverInvalidUrl: 'Veuillez saisir une URL valide, par ex. https://votre-serveur.com.',
        serverNotTangerine: 'Cette URL ne correspond pas à un serveur Tangerine compatible avec cette application. Veuillez saisir la version correcte de Tangerine.',
        serverUnreachable: 'Impossible de joindre ce serveur. Vérifiez l\u2019URL et votre connexion, puis réessayez.',
        fillAll: 'Veuillez remplir tous les champs.',
        sessionExpired: 'Votre session a expiré. Veuillez vous reconnecter.',
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
        updatingOne: 'Mise à jour de {count} formulaire téléchargé…',
        updatingMany: 'Mise à jour de {count} formulaires téléchargés…',
        updated: '✓ Formulaires téléchargés mis à jour',
        failed: '↷ Actualisation impossible — formulaires téléchargés conservés tels quels',
      },
      sync: {
        upToDate: '✓ Tous les formulaires téléchargés sont à jour',
        cancelling: 'Annulation de la mise à jour…',
        cancelled: '↷ Mise à jour annulée',
        progress: 'Mise à jour de {done} sur {total}…',
        updated: '✓ {count} formulaire(s) téléchargé(s) mis à jour',
        partial: '{updated} mis à jour, {failed} en échec',
        failed: '↷ Mise à jour impossible — formulaires téléchargés conservés',
        updateAvailable: 'Mise à jour disponible',
        staleTitle: 'Une version plus récente est sur le serveur — appuyez pour mettre à jour',
        buttonTitle: 'Synchroniser : envoyer les réponses et mettre à jour les formulaires téléchargés',
        buttonBusy: 'Synchronisation — appuyez pour annuler',
      },
      responses: {
        partial: '{updated} envoyée(s), {failed} non envoyée(s)',
        failed: '↷ Envoi des réponses impossible — elles sont conservées sur cet appareil',
      },
      about: {
        title: 'À propos',
        appName: 'Tangerine Data Collector',
        version: 'Version',
        server: 'Serveur',
        user: 'Utilisateur',
        close: 'Fermer',
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
