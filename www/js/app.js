// App entry point
document.addEventListener('DOMContentLoaded', async () => {
  // Initialize the Respect proxy cache service
  try {
    await cacheService.init();
    console.log('[App] Cache service initialized');
  } catch (err) {
    console.warn('[App] Cache service init failed:', err);
  }

  views.init();

  // Register deep link handler (Capacitor appUrlOpen)
  if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
    window.Capacitor.Plugins.App.addListener('appUrlOpen', (data) => {
      console.log('[App] Deep link received:', data.url);
      handleDeepLink(data.url);
    });

    // Check if app was opened via a deep link on cold start
    window.Capacitor.Plugins.App.getLaunchUrl().then((launchData) => {
      if (launchData && launchData.url) {
        console.log('[App] Cold start from deep link:', launchData.url);
        handleDeepLink(launchData.url);
      }
    }).catch((err) => {
      console.warn('[App] getLaunchUrl not supported:', err);
    });
  }
});

/**
 * Handle an incoming deep link URL (RESPECT protocol launch).
 * Expected format:
 *   http://<contentServer>/releases/prod/online-survey-apps/<groupId>/<formId>/
 *     ?endpoint=<xapiEndpoint>&auth=<basicAuth>&actor=<actorJson>&activity_id=<path>
 *     #/form/<formId>
 *
 * NOTE: `<contentServer>` (the origin of this URL) is the Tangerine server that
 * hosts the lesson AND the OPDS groups/forms feeds — the server the shell uses.
 * The `endpoint` query param is the xAPI endpoint (usually the RESPECT server)
 * that the form reports statements to, NOT the content server; it must never be
 * used as the shell's API base URL. (An older proxy form `endpoint=http://<proxy>/
 * e/<tangerine-url>` is still honoured below.)
 */
async function handleDeepLink(urlString) {
  try {
    const url = new URL(urlString);

    // Extract query parameters
    const endpointParam = url.searchParams.get('endpoint');
    const authParam = url.searchParams.get('auth');
    const actorParam = url.searchParams.get('actor');
    const ipcPackageParam = url.searchParams.get('xapiIpcPackage');

    // The RESPECT `auth` header verbatim (e.g. "Basic <base64>"), if present.
    let basicAuthHeader = null;

    // Decide which Tangerine server the shell should use for its own group/form
    // listing. In a RESPECT NATIVE deep link the launched lesson URL is served
    // straight from the Tangerine content/OPDS server, while the `endpoint`
    // query param is the xAPI endpoint (the RESPECT server) that the form
    // reports statements to — NOT the content server. Treating `endpoint` as
    // the shell's base URL points group/form discovery at the LRS, which has no
    // API routes (everything 404s). So:
    //   - proxy form  http://<proxy>/e/<tangerine-url>  → use the inner URL
    //   - otherwise                                    → use the lesson URL origin
    let serverUrl = '';
    if (endpointParam) {
      // Decode the endpoint fully (it may be double-encoded)
      let decodedEndpoint = endpointParam;
      for (let i = 0; i < 3; i++) {
        const decoded = decodeURIComponent(decodedEndpoint);
        if (decoded === decodedEndpoint) break;
        decodedEndpoint = decoded;
      }
      // Extract the actual Tangerine server from proxy URL pattern
      // Pattern: http://<proxy>/e/<tangerine-url>
      const proxyMatch = decodedEndpoint.match(/\/e\/(http.+)/);
      if (proxyMatch) {
        serverUrl = decodeURIComponent(proxyMatch[1]);
      }
    }
    if (!serverUrl && url.origin && url.origin !== 'null') {
      serverUrl = url.origin;
    }
    if (serverUrl) {
      // Clean up the server URL
      serverUrl = serverUrl.replace(/\/+$/, '');
      console.log('[App] Deep link resolved server URL:', serverUrl);
      api.setBaseUrl(serverUrl);
    }

    // Store auth header if provided.
    if (authParam) {
      const decodedAuth = decodeURIComponent(authParam);
      // Format: "Basic <base64>"
      const authMatch = decodedAuth.match(/Basic\s+(.+)/);
      if (authMatch) {
        basicAuthHeader = decodedAuth;
        try {
          const decoded = atob(authMatch[1]);
          const [username] = decoded.split(':');
          if (username) {
            localStorage.setItem('username', username);
          }
        } catch (e) {
          console.warn('[App] Failed to decode Basic auth header:', e);
        }
      }
      // Keep a working Authorization header available immediately. The OPDS
      // group/form feeds accept Basic, so the shell can list groups/forms even
      // before we upgrade to a real JWT session below.
      localStorage.setItem('token', decodedAuth);
    }

    // Store actor info if provided
    if (actorParam) {
      try {
        const actor = JSON.parse(decodeURIComponent(actorParam));
        if (actor.name) {
          localStorage.setItem('username', actor.name);
        }
      } catch (e) {
        console.warn('[App] Failed to parse actor param:', e);
      }
    }

    // NOTE: Deliberately do NOT record this launch into the recent
    // servers/usernames list. The deep link is an automated launch from
    // RESPECT — the user never typed this URL on the login screen — so
    // persisting it would pollute the "recent servers" chips shown at next
    // login. Only real form-based logins (api.login()) are recorded; the
    // background session upgrade below also uses record:false.

    // Prepare the logged-in groups screen underneath the lesson view.
    views.goHome();

    // Open the launched lesson in Tangerine's OWN in-app browser (the cached WebView),
    // passing the launch URL through VERBATIM (all query params intact: endpoint, auth,
    // actor, activity_id, xapiIpcPackage). The form player reads those params from the URL to
    // configure/relay xAPI, so the URL must not be stripped or rewritten here.
    //
    // Mark it as launched from RESPECT so that closing / backing out of the lesson
    // returns the user to RESPECT (instead of leaving them on the Tangerine group list).
    views.openFormInWebView(urlString, {
      launchedFromRespect: true,
      ipcPackage: ipcPackageParam || undefined
    });

    // The RESPECT Basic credentials are enough for the OPDS feeds, but the
    // shell's own endpoints (and group discovery via a real respectUrl) need
    // the JWT minted by /login. Upgrade in the background — never block the
    // lesson from opening on this — so the groups screen underneath the lesson
    // is populated. record:false keeps the "recent servers" history clean.
    if (basicAuthHeader) {
      api.loginFromBasicAuth(basicAuthHeader).then((ok) => {
        if (ok && views && typeof views.renderGroups === 'function') {
          // A fresh session (JWT + respectUrl) now exists — repopulate the
          // groups list behind the lesson without adding a history entry.
          views.renderGroups({ skipHistory: true }).catch(() => {});
        }
      }).catch((err) => {
        console.warn('[App] RESPECT background session upgrade failed:', err);
      });
    }
  } catch (err) {
    console.error('[App] Failed to handle deep link:', err);
  }
}