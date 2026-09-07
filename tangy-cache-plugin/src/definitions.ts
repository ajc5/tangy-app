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

export interface OfflineUrl {
  url: string;
  remark?: string;
}

export interface TangyCachePlugin {
  store(options: { url: string; mimeType: string; body: string; headers?: Record<string, string> }): Promise<void>;
  retrieve(options: { url: string }): Promise<{ body: string; mimeType: string; headers: Record<string, string> } | null>;
  isCached(options: { url: string }): Promise<{ cached: boolean }>;
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
}
