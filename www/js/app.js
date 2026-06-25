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
 *   http://<host>/releases/prod/online-survey-apps/<groupId>/<formId>/
 *     ?endpoint=<serverUrl>&auth=<basicAuth>&actor=<actorJson>&activity_id=<path>
 *     #/form/<formId>
 */
async function handleDeepLink(urlString) {
  try {
    const url = new URL(urlString);

    // Extract query parameters
    const endpointParam = url.searchParams.get('endpoint');
    const authParam = url.searchParams.get('auth');
    const actorParam = url.searchParams.get('actor');

    if (endpointParam) {
      // Decode the endpoint fully (it may be double-encoded)
      let serverUrl = endpointParam;
      // Decode until there's no %-encoded sequences left (max 3 rounds)
      for (let i = 0; i < 3; i++) {
        const decoded = decodeURIComponent(serverUrl);
        if (decoded === serverUrl) break;
        serverUrl = decoded;
      }
      // Extract the actual Tangerine server from proxy URL pattern
      // Pattern: http://<proxy>/e/<tangerine-url>
      const proxyMatch = serverUrl.match(/\/e\/(http.+)/);
      if (proxyMatch) {
        serverUrl = decodeURIComponent(proxyMatch[1]);
      }

      // Clean up the server URL
      serverUrl = serverUrl.replace(/\/+$/, '');
      console.log('[App] Deep link resolved server URL:', serverUrl);
      api.setBaseUrl(serverUrl);
    }

    // Store auth header if provided
    if (authParam) {
      const decodedAuth = decodeURIComponent(authParam);
      // Format: "Basic <base64>"
      const authMatch = decodedAuth.match(/Basic\s+(.+)/);
      if (authMatch) {
        const decoded = atob(authMatch[1]);
        const [username] = decoded.split(':');
        if (username) {
          localStorage.setItem('username', username);
        }
      }
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

    // Navigate to groups view
    views.goHome();
  } catch (err) {
    console.error('[App] Failed to handle deep link:', err);
  }
}