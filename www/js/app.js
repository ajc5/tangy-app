// App entry point
document.addEventListener('DOMContentLoaded', async () => {
  // Initialize the cache service for offline-first support
  try {
    await cacheService.init();
    console.log('[App] Cache service initialized');
  } catch (err) {
    console.warn('[App] Cache service init failed:', err);
  }

  views.init();
});