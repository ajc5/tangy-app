/// <reference types="@capacitor/core" />

declare module '@capacitor/core' {
  interface PluginRegistry {
    TangyCache: TangyCachePlugin;
  }
}

export interface CacheEntry {
  url: string;
  mimeType: string;
  sizeBytes: number;
  storedAt: number;
  lastValidated: number;
}

export interface PinProgress {
  status: 'not-pinned' | 'preparing' | 'in-progress' | 'ready' | 'failed';
  totalSize: number;
  transferred: number;
}

export interface CacheStats {
  entryCount: number;
  totalSizeBytes: number;
  sizeLimitBytes: number;
}

/**
 * Metadata for a cached URL. Returned by `getCacheInfo` without reading the
 * stored body, so the UI can decide whether a pinned form is stale.
 */
export interface CacheInfo {
  url: string;
  cached: boolean;
  /** Local clock at the time the entry was (re)validated, ms since epoch. */
  storedAt: number;
  sizeBytes: number;
  /** Validators from the origin response, if it sent any. */
  etag: string;
  lastModified: string;
  cacheControl: string;
  /** `Date` header from the response that stored this copy (server clock). */
  serverDate: string;
}

export interface OfflineUrl {
  url: string;
  remark?: string;
}

export interface TangyCachePlugin {
  store(options: { url: string; mimeType: string; body: string; headers?: Record<string, string> }): Promise<void>;
  retrieve(options: { url: string }): Promise<{ body: string; mimeType: string; headers: Record<string, string> } | null>;
  isCached(options: { url: string }): Promise<{ cached: boolean }>;
  /**
   * Metadata (validators, server Date, storedAt) for one or more cached URLs,
   * without reading the bodies. Used to detect stale pinned forms.
   */
  getCacheInfo(options: { urls?: string[]; url?: string }): Promise<{ entries: CacheInfo[] }>;
  /**
   * Remove specific URLs from the disk cache (uncache). No-op for URLs
   * that are not currently cached.
   */
  evict(options: { urls: string[] }): Promise<{ removed: number }>;
  downloadAndRetain(options: { urls: OfflineUrl[] }): Promise<{ jobId: string }>;
  release(options: { jobId: string }): Promise<void>;
  getPinProgress(options: { manifestUrl: string }): Promise<{ progress: PinProgress }>;
  getStats(): Promise<{ stats: CacheStats }>;
  clear(): Promise<void>;
  setDistributedCachingEnabled(options: { enabled: boolean }): Promise<void>;

  /**
   * Make an HTTP request through OkHttp with CacheInterceptor (Respect-style).
   * On native, GET responses are automatically cached to disk and served
   * offline. Non-GET requests (POST/PUT/DELETE) always hit the network and
   * are never cached.
   */
  fetch(options: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<{ ok: boolean; status: number; body: string; contentType: string }>;

  /**
   * Open a URL in an in-app WebView that uses CachingWebViewClient
   * (OkHttp + CacheInterceptor), ensuring all content is cached for offline use.
   *
   * When `launchedFromRespect` is true (a lesson opened via a RESPECT deep link),
   * closing / backing out of the WebView returns the user to the RESPECT launcher
   * instead of revealing the Tangerine UI underneath.
   */
  openCachedWebView(options: {
    url: string;
    showToolbar?: boolean;
    closeButtonText?: string;
    /** True when the form is a RESPECT-launched lesson (opened via a deep link). */
    launchedFromRespect?: boolean;
    /** The launcher's package name (the `xapiIpcPackage` launch param). */
    ipcPackage?: string;
    /**
     * Show the DEMO MODE pill in the overlay's native toolbar.
     *
     * Demo mode is a property of the SERVER, not of a screen, so it has to keep
     * showing while a form is open — the form overlay is a separate WebView and
     * would otherwise be the one place the pill disappears.
     */
    demoMode?: boolean;
    /** Label for that pill (defaults to "DEMO MODE"); pass the translated string. */
    demoModeLabel?: string;
  }): Promise<void>;

  /**
   * Forward xAPI statements (created by the Tangerine server) back to the RESPECT /
   * Open Educational Experience Launcher that launched this lesson, via the launcher's
   * xAPI-over-IPC service. Statements are relayed only — never originated by this app.
   *
   * @param endpoint       the xAPI endpoint URL from the RESPECT launch parameters
   * @param auth           the auth header value from the RESPECT launch parameters
   * @param ipcPackage     the launcher's package name (the `xapiIpcPackage` launch parameter)
   * @param statementsJson JSON array of xAPI statements to relay (as produced by the server)
   */
  forwardXapiStatements(options: {
    endpoint: string;
    auth: string;
    ipcPackage: string;
    statementsJson: string;
  }): Promise<{ ok: boolean; count: number; result: string }>;

  /**
   * Take ownership of an xAPI statement batch the WebView cannot deliver itself.
   *
   * The batch is written to disk and a connectivity-constrained WorkManager job relays
   * it to the launcher over IPC, so delivery happens when the network returns — even if
   * this app has been killed in the meantime. Resolves once the batch is durable, which
   * is the caller's signal that it may drop its own copy. Queueing the same batch twice
   * is a no-op (batches are content-addressed).
   */
  queueXapiStatements(options: {
    endpoint: string;
    auth: string;
    ipcPackage: string;
    statementsJson: string;
  }): Promise<{ ok: boolean; pending: number }>;

  /**
   * How many form responses are queued on disk because they could not be sent.
   *
   * Submissions made with no network are written to a durable queue and
   * uploaded automatically when connectivity returns; this is the count the UI
   * shows so the user knows their work is held on the device rather than lost.
   */
  getPendingCount(): Promise<{ count: number }>;

  /**
   * Upload every queued response now.
   *
   * Responses the server rejects stay in the queue (a 4xx/5xx is the user's
   * data, not something to discard), so `remaining` can be non-zero afterwards.
   * Safe to call while the automatic post-reconnect upload is running: drains
   * are serialised and each response is claimed before it is sent.
   */
  syncPending(): Promise<{
    synced: number;
    failed: number;
    xapiSynced: number;
    remaining: number;
    /** True when the automatic post-reconnect upload already had the queue. */
    skipped: boolean;
  }>;

  /** Discard every queued response. Destructive — not surfaced in the app UI. */
  clearPending(): Promise<void>;
}
