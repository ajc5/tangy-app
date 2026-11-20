// View management
const views = {
  _history: [],
  _currentGroupId: null,
  _currentGroupName: null,
  // Set when the server rejected our token, so background jobs that fail as a
  // consequence do not also throw an unrelated "could not cache" dialog on top
  // of the login screen we just showed.
  _sessionExpired: false,
  _cachedItems: new Set(JSON.parse(localStorage.getItem('cached-items') || '[]')),

  // Responses queued on the device because they were submitted with no network,
  // and a guard so one header sync runs at a time.
  _pendingResponses: 0,
  _headerSyncRunning: false,

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

  // ── Queued (offline) responses ──────────────────────────────────────────
  //
  // A form submitted with no network is queued on disk by the native plugin and
  // uploaded automatically when connectivity returns (the ConnectivityManager
  // callback in TangyCachePlugin). Nothing used to report that: the form overlay
  // closes exactly as it does for a delivered response, so a queued response was
  // invisible. That and a form that fell behind the server are both "this device
  // is not current" states, and the header's sync button fixes both — see
  // _onHeaderSync().

  /**
   * Is any downloaded form on this screen behind the server?
   *
   * `_isGroupStale` covers forms pinned as part of a group; a form pinned on its
   * own is not in `cached-group-forms`, so the rendered rows are checked too.
   */
  _hasStaleDownloads() {
    const groupId = this._currentGroupId;
    if (!groupId) return false;
    if (this._isGroupStale(groupId)) return true;
    return (this._formRows || []).some(row =>
      row.groupId === groupId && row.cached && this._isFormMarkedStale(row.formUrl)
    );
  },

  /**
   * Dot on the sync button while it has something to do: responses waiting to
   * upload, or a downloaded form that has a newer version on the server.
   *
   * Deliberately not a count: the header answers "is anything out of date?" at a
   * glance, and a sync reports the numbers. Silent when there is nothing to do.
   */
  async _refreshSyncDot() {
    const plugin = window.Capacitor?.Plugins?.TangyCache;
    if (plugin && typeof plugin.getPendingCount === 'function') {
      try {
        const result = await plugin.getPendingCount();
        this._pendingResponses = (result && result.count) || 0;
      } catch (e) {
        this._pendingResponses = 0;
      }
    } else {
      this._pendingResponses = 0;
    }
    this._paintSyncDot();
  },

  /** Paint the dot from the two things a sync would fix. Synchronous. */
  _paintSyncDot() {
    const dot = document.querySelector('.menu-sync-dot');
    if (!dot) return;
    const stale = this._hasStaleDownloads();
    dot.hidden = !(this._pendingResponses > 0 || stale);
    console.log('[VIEWS] sync dot', JSON.stringify({
      pending: this._pendingResponses,
      groupId: this._currentGroupId,
      groupStale: this._currentGroupId ? this._isGroupStale(this._currentGroupId) : null,
      rowStale: (this._formRows || []).map(r => [r.groupId, r.cached, this._isFormMarkedStale(r.formUrl)]),
      stale,
      hidden: dot.hidden,
    }));
  },

  /**
   * Upload every queued response now. Silent: the caller reports the outcome.
   *
   * Each response is deleted only once the server accepts it, so `failed` can be
   * non-zero while `synced` is too.
   *
   * @returns {Promise<{synced: number, failed: number, skipped: boolean}|null>}
   */
  async _uploadQueuedResponses() {
    const plugin = window.Capacitor?.Plugins?.TangyCache;
    if (!plugin || typeof plugin.syncPending !== 'function') return null;
    try {
      const result = await plugin.syncPending();
      return {
        synced: (result && result.synced) || 0,
        failed: (result && result.failed) || 0,
        // The automatic post-reconnect drain already owned the queue.
        skipped: !!(result && result.skipped),
      };
    } catch (e) {
      console.warn('[VIEWS] Uploading queued responses failed:', e);
      return null;
    }
  },

  /**
   * Header sync: deliver queued responses, then update this group's downloaded
   * forms.
   *
   * Responses go first because they are the only unsent data here — a form
   * update is only a refresh — and the update half keeps its own progress and
   * summary toasts, so it speaks last. A failed upload is re-reported at the end
   * so a successful form update can never mask it.
   */
  async _onHeaderSync(buttonEl, onSync) {
    if (this._headerSyncRunning) return;
    this._headerSyncRunning = true;
    if (buttonEl) {
      buttonEl.classList.add('is-syncing');
      buttonEl.setAttribute('aria-busy', 'true');
      buttonEl.setAttribute('aria-label', t('sync.buttonBusy'));
    }
    try {
      const pending = await this._uploadQueuedResponses();
      await onSync();
      if (pending && pending.failed > 0) {
        this._toast(pending.synced > 0
          ? t('responses.partial', { updated: pending.synced, failed: pending.failed })
          : t('responses.failed'));
      }
    } catch (e) {
      console.warn('[VIEWS] Sync failed:', e);
      this._toast(t('sync.failed'));
    } finally {
      this._headerSyncRunning = false;
      if (buttonEl) {
        buttonEl.classList.remove('is-syncing');
        buttonEl.removeAttribute('aria-busy');
        buttonEl.setAttribute('aria-label', t('sync.buttonTitle'));
      }
      // Both halves changed the state the dot reports: responses may have left
      // the queue, and the update cleared (or refreshed) the stale marks.
      await this._refreshSyncDot();
    }
  },

  // ── In-flight download registry ─────────────────────────────────────────
  //
  // Progress used to live only on the row's <button> (its _dlBusy/_dlSignal),
  // so navigating away and back re-rendered a brand-new button that knew
  // nothing about the job still running. Jobs are registered here, keyed like
  // the cache ('form:<url>' / 'group:<id>'), and the render path re-attaches
  // the ring to whichever button currently represents the job.

  _activeDownloads: new Map(),

  _registerDownload(key, btnId, signal) {
    this._activeDownloads.set(key, { btnId, signal, progress: undefined });
    const btn = btnId ? document.getElementById(btnId) : null;
    if (btn) {
      btn._dlSignal = signal;
      this._setDownloadBtnBusy(btn);
    }
  },

  /** Move the ring of an active job, wherever its row currently lives. */
  _setDownloadProgress(key, progress) {
    const job = this._activeDownloads.get(key);
    if (!job) return;
    job.progress = progress;
    // A child form update also drives its group's aggregate ring (the group row
    // may be the visible one, e.g. after navigating back to the group list),
    // and a group download drives every form row of that group.
    if (key.startsWith('group:')) {
      this._refreshFormRowsForGroup(key.substring('group:'.length));
    } else {
      this._refreshGroupBadgeForFormKey(key);
    }
    const btn = job.btnId ? document.getElementById(job.btnId) : null;
    if (!btn) return;                  // row not on screen — the job still runs
    if (!btn._dlSignal) btn._dlSignal = job.signal;
    this._setDownloadBtnBusy(btn, progress);
  },

  /** Cancel an active job from a re-rendered row. */
  _cancelDownloadJob(key) {
    const job = this._activeDownloads.get(key);
    if (!job || job.signal.cancelled) return;
    job.signal.cancelled = true;
    const btn = job.btnId ? document.getElementById(job.btnId) : null;
    if (!btn) return;
    btn.disabled = true;
    btn.setAttribute('aria-label', 'Cancelling download');
    btn.setAttribute('aria-busy', 'true');
    btn.innerHTML = this._downloadProgressMarkup(undefined, true);
  },

  /**
   * Re-attach a still-running job to a freshly rendered button.
   * @returns true when the button should stay in the busy state.
   */
  _resumeDownloadBadge(key, buttonEl) {
    const job = this._activeDownloads.get(key);
    if (!job) return false;
    if (buttonEl.id) job.btnId = buttonEl.id;
    buttonEl._dlSignal = job.signal;
    buttonEl._dlCancelAll = null;   // an own job cancels through its signal
    buttonEl._groupBusy = false;    // that ring is a per-form job's own
    this._setDownloadBtnBusy(buttonEl, job.progress);
    return true;
  },

  /** The element now representing a job (its row may have been re-rendered). */
  _currentJobButton(key, fallback = null) {
    const job = this._activeDownloads.get(key);
    const el = job && job.btnId ? document.getElementById(job.btnId) : null;
    return el || fallback;
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
    buttonEl._stale = false;
    buttonEl.removeAttribute('aria-busy');
    buttonEl.removeAttribute('data-stale');
    if (buttonEl.dataset.baseTitle) buttonEl.title = buttonEl.dataset.baseTitle;
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

  /**
   * Stale state: the form is cached, but the server's publication
   * `metadata.modified` is newer than the copy on disk. Orange check instead of
   * green. A tap means "download the update", never "uncache" (see the toggle
   * in cacheFormResources).
   */
  _setDownloadBtnStale(buttonEl) {
    this._clearDownloadBusy(buttonEl);
    buttonEl.removeAttribute('aria-busy');
    buttonEl._stale = true;
    buttonEl.setAttribute('data-stale', '1');
    buttonEl.setAttribute('aria-label', t('sync.updateAvailable'));
    buttonEl.title = t('sync.staleTitle');
    buttonEl.innerHTML = '<span class="dl-stale">✓</span>';
    buttonEl.style.color = '#ef6c00';
    buttonEl.style.borderColor = '';
    buttonEl.disabled = false;
    buttonEl.style.opacity = '1';
  },

  _setDownloadBtnUncached(buttonEl) {
    this._clearDownloadBusy(buttonEl);
    buttonEl._stale = false;
    buttonEl.removeAttribute('aria-busy');
    buttonEl.removeAttribute('data-stale');
    if (buttonEl.dataset.baseTitle) buttonEl.title = buttonEl.dataset.baseTitle;
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
    buttonEl._dlCancelAll = null;
    buttonEl._groupBusy = false;
  },

  /**
   * Busy state: a circular progress ring around a centred glyph, mirroring the
   * RESPECT app's RespectOfflineItemStatusIcon. With no argument the ring spins
   * (indeterminate, used while resources are still being discovered); pass
   * `progress` (0..1) for a determinate arc.
   *
   * The centred glyph is the stop square whenever the job can still be
   * cancelled (a `_dlSignal` is registered), and the download arrow for the
   * operations that cannot be interrupted (evicting a pinned item). That is
   * RESPECT's swap too: it draws Icons.Default.Stop while a publication is
   * being fetched and FileDownload otherwise, so the icon shows what a tap
   * will do.
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
    buttonEl.innerHTML = this._downloadProgressMarkup(
      progress, !!(buttonEl._dlSignal || buttonEl._dlCancelAll)
    );
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

  /**
   * Busy markup: the progress ring plus its centred glyph. `showStop` swaps the
   * download arrow for Material's `stop` square — the same pair RESPECT draws.
   */
  _downloadProgressMarkup(progress, showStop) {
    const { dash, gap, determinate } = this._downloadRingDash(progress);
    const glyph = showStop
      ? '<svg class="dl-progress-stop" viewBox="0 0 24 24" aria-hidden="true">' +
          '<path d="' + this._ICON_PATHS.stop + '"/>' +
        '</svg>'
      : '<svg class="dl-progress-arrow" viewBox="0 0 24 24" aria-hidden="true">' +
          '<path d="' + this._ICON_PATHS.download + '"/>' +
        '</svg>';
    return '<span class="dl-progress">' +
      '<svg class="dl-progress-ring-svg' + (determinate ? '' : ' is-indeterminate') + '" viewBox="0 0 24 24" aria-hidden="true">' +
        '<circle class="dl-progress-ring" cx="12" cy="12" r="10.5" ' +
          'stroke-dasharray="' + dash + '" stroke-dashoffset="' + gap + '"/>' +
      '</svg>' +
      glyph +
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
    // A group row can aggregate several child form jobs; it stops them all.
    if (typeof buttonEl._dlCancelAll === 'function') {
      buttonEl._dlCancelAll();
      buttonEl.disabled = true;                 // one cancel per job
      buttonEl.setAttribute('aria-label', 'Cancelling download');
      buttonEl.setAttribute('aria-busy', 'true');
      buttonEl.innerHTML = this._downloadProgressMarkup(undefined, true);
      return;
    }
    const signal = buttonEl._dlSignal;
    if (!signal || signal.cancelled) return;
    signal.cancelled = true;
    console.log('[VIEWS] Download cancelled by user');
    buttonEl.disabled = true;                 // one cancel per job
    buttonEl.setAttribute('aria-label', 'Cancelling download');
    buttonEl.setAttribute('aria-busy', 'true');
    // Keep the ring moving until the in-flight request settles. The stop square
    // stays put: the tap was only registered, the job is still winding down.
    buttonEl.innerHTML = this._downloadProgressMarkup(undefined, true);
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
        // An adopted shell may still be behind the server's version.
        if (this._isFormMarkedStale(formUrl)) this._setDownloadBtnStale(buttonEl);
        else this._setDownloadBtnCached(buttonEl);
        console.log('[VIEWS] Auto-marked form cached (found on disk):', formUrl);
      }
    } catch (e) {
      console.warn('[VIEWS] Badge reconcile failed:', e);
    }
  },

  // ── Stale-cache detection / sync ─────────────────────────────────────────

  /**
   * The publication detail URL for a form (what the server's rel=self points at
   * in the group listing). Derived from the release URL when the listing did not
   * carry an explicit self link.
   */
  _publicationDetailUrl(formUrl) {
    const match = String(formUrl || '').match(
      /\/releases\/prod\/online-survey-apps\/([^/]+)\/([^/]+)\//
    );
    if (!match) return null;
    const token = (api._getRespectToken ? api._getRespectToken() : '') || '';
    return `${api.getBaseUrl()}/opds/groups/${match[1]}/${match[2]}` +
      (token ? `?respectToken=${token}` : '');
  },

  // ── Stale-cache bookkeeping ─────────────────────────────────────────────
  //
  // `cached-form-version`: formUrl → the publication `metadata.modified` that
  // was current when the form's resources were last downloaded. Comparing the
  // server's current value against THIS (a content version) — not against a
  // fetch timestamp — is what makes the badge stable: it does not depend on
  // when we fetched, on max-age, or on the device clock, so it cannot flip.
  //
  // `stale-form-urls`: forms already known to be behind, persisted so a re-
  // render paints orange immediately instead of flashing green then orange.

  _getFormKnownVersion(formUrl) {
    try {
      const map = JSON.parse(localStorage.getItem('cached-form-version') || '{}');
      return map[formUrl] || null;
    } catch (e) { return null; }
  },

  _saveFormKnownVersion(formUrl, modified) {
    if (!formUrl || !modified) return;
    try {
      const map = JSON.parse(localStorage.getItem('cached-form-version') || '{}');
      map[formUrl] = modified;
      localStorage.setItem('cached-form-version', JSON.stringify(map));
    } catch (e) { /* ignore */ }
  },

  _isFormMarkedStale(formUrl) {
    try {
      const list = JSON.parse(localStorage.getItem('stale-form-urls') || '[]');
      return Array.isArray(list) && list.includes(formUrl);
    } catch (e) { return false; }
  },

  _setFormStaleMark(formUrl, stale) {
    if (!formUrl) return;
    try {
      const list = new Set(JSON.parse(localStorage.getItem('stale-form-urls') || '[]'));
      if (stale) list.add(formUrl);
      else list.delete(formUrl);
      localStorage.setItem('stale-form-urls', JSON.stringify([...list]));
    } catch (e) { /* ignore */ }
    // Staleness is discovered asynchronously (background probe, uncache), and
    // the header's sync dot reports it — repaint here so the dot appears without
    // waiting for the next navigation.
    this._paintSyncDot();
  },

  /**
   * Was this cached form re-published on the server since we downloaded it?
   *
   * Compares the publication's per-form `metadata.modified` (from the
   * publication detail) with the `Date` header the server itself sent when our
   * copy was stored, so device clock skew cannot cause false positives.
   */
  /**
   * Fingerprint of the descriptor's *content definition*: the resource set,
   * reading order and images.
   *
   * Deliberately excludes `metadata.modified`, `Last-Modified` and the
   * descriptor's own links (they carry the respectToken). Those move when a
   * form is merely published/unpublished or the server rebuilds the release,
   * which must never look like a content change.
   */
  _formSignature(manifest) {
    if (!manifest) return null;
    const strip = (href) => String(href || '').split('?')[0];
    const payload = JSON.stringify({
      images: (manifest.images || []).map(i => strip(i.href)).sort(),
      resources: (manifest.resources || []).map(r => strip(r.href)).sort(),
      readingOrder: (manifest.readingOrder || []).map(r => strip(r.href)),
    });
    let h = 0x811c9dc5;                       // FNV-1a, plenty for an equality check
    for (let i = 0; i < payload.length; i++) {
      h ^= payload.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return `${h.toString(16)}:${payload.length}`;
  },

  _getFormSignature(formUrl) {
    try {
      const map = JSON.parse(localStorage.getItem('cached-form-signature') || '{}');
      return map[formUrl] || null;
    } catch (e) { return null; }
  },

  _saveFormSignature(formUrl, signature) {
    if (!formUrl || !signature) return;
    try {
      const map = JSON.parse(localStorage.getItem('cached-form-signature') || '{}');
      map[formUrl] = signature;
      localStorage.setItem('cached-form-signature', JSON.stringify(map));
    } catch (e) { /* ignore */ }
  },

  async _isFormStale(formUrl, selfUrl, { force = false } = {}) {
    if (!selfUrl) return false;
    const manifest = await api.getFormManifest(selfUrl, { force });
    if (!manifest) return false;

    const modified = manifest.metadata && manifest.metadata.modified;
    const signature = this._formSignature(manifest);
    const knownVersion = this._getFormKnownVersion(formUrl);
    const knownSignature = this._getFormSignature(formUrl);

    if (!knownVersion || !knownSignature) {
      // Cached before these signals existed: adopt the current server state as
      // the baseline instead of guessing — no false badge.
      this._saveFormKnownVersion(formUrl, modified);
      this._saveFormSignature(formUrl, signature);
      return false;
    }

    // Definitive: the form's files/reading order changed.
    if (signature && knownSignature && signature !== knownSignature) {
      console.log('[VIEWS] Form is stale (content definition changed):', formUrl);
      return true;
    }

    const knownMs = Date.parse(knownVersion);
    const serverMs = modified ? Date.parse(modified) : NaN;
    const moved = isFinite(knownMs) && isFinite(serverMs) && serverMs > knownMs + 1000;
    if (!moved) return false;

    // `metadata.modified` moved but the descriptor still describes the same
    // content — exactly what a publish/unpublish (which touches group-level
    // files) or a rebuild produces. Confirm against the form document itself.
    const verdict = await this._formContentUnchanged(formUrl, manifest);
    if (verdict === 'same') {
      this._saveFormKnownVersion(formUrl, modified);
      console.log('[VIEWS] Not stale: timestamp moved but form content is identical:', formUrl);
      return false;
    }
    if (verdict === 'unknown') {
      // Never clear a real "update available" on a failed probe, and never
      // invent one either: keep the previous verdict.
      return this._isFormMarkedStale(formUrl);
    }

    console.log('[VIEWS] Form is stale:', formUrl,
      'server modified', modified, 'vs cached version', knownVersion);
    return true;
  },

  /**
   * Compare the form's own document(s) on the server with the cached copies.
   *
   * Tangerine publishes the form definition as `<release>/assets/form/*.html`;
   * the release's index.html shell is shared by every form, so it cannot be
   * used to detect changes. Only one or two small files are fetched, and only
   * when the descriptor timestamp moved.
   *
   * @returns {'same'|'different'|'unknown'} 'same' only when verified equal;
   *          'unknown' when there is nothing to compare against or the fetch
   *          failed (caller keeps its previous verdict).
   */
  async _formContentUnchanged(formUrl, manifest) {
    const plugin = window.Capacitor?.Plugins?.TangyCache;
    if (!plugin || !plugin.retrieve) return 'unknown';

    const formDocs = ((manifest && manifest.resources) || [])
      .map(r => r.href)
      .filter(href => /\/assets\/form\//.test(href || ''));
    if (formDocs.length === 0) {
      console.warn('[VIEWS] No form-specific resource to compare for', formUrl);
      return 'unknown';
    }

    let compared = false;
    for (const href of formDocs) {
      const url = href.startsWith('http') ? href : `${api.getBaseUrl()}${href}`;
      let cachedBody = null;
      try {
        const cached = await plugin.retrieve({ url });
        cachedBody = cached && typeof cached.body === 'string' ? cached.body : null;
      } catch (e) { /* treat as unavailable */ }
      if (cachedBody == null) continue;         // nothing to compare against

      try {
        const resp = await httpClient.get(url, {
          'Authorization': localStorage.getItem('token'),
          'X-Tangy-Refresh': '1',           // bypass a still-fresh copy
          // Compare, don't keep: a staleness probe must never replace the
          // cached bytes it is measuring (otherwise the next check would find
          // its own download and clear the badge).
          'X-Tangy-No-Store': '1',
        });
        if (!resp.ok) return 'unknown';
        compared = true;
        if ((await resp.text()) !== cachedBody) {
          console.log('[VIEWS] Form document changed:', url);
          return 'different';
        }
      } catch (e) {
        console.warn('[VIEWS] Content check failed for', url, e.message);
        return 'unknown';
      }
    }
    return compared ? 'same' : 'unknown';
  },

  _getLastFeedMod(groupId) {
    try {
      const map = JSON.parse(localStorage.getItem('last-form-feed-mod') || '{}');
      return map[groupId] || null;
    } catch (e) { return null; }
  },

  _saveLastFeedMod(groupId, modified) {
    if (!groupId || !modified) return;
    try {
      const map = JSON.parse(localStorage.getItem('last-form-feed-mod') || '{}');
      map[groupId] = modified;
      localStorage.setItem('last-form-feed-mod', JSON.stringify(map));
    } catch (e) { /* ignore */ }
  },

  /**
   * Paint the orange "update available" badge on cached forms the server has
   * re-published.
   *
   * Cost control: the group feed carries a feed-level `modified` that moves
   * whenever anything in the group changes (form content, publish/unpublish).
   * If it is unchanged since the last check no per-form request is made at all.
   * When it did move, the per-form probes are FORCED (`X-Tangy-Refresh`) so a
   * change is noticed immediately instead of after the descriptor's 300s
   * max-age; each probe is a small conditional GET that normally answers 304.
   *
   * @returns number of stale forms found.
   */
  async _checkFormStaleness(rows, { force = false, feedModified = null, groupId = null, renderId = null } = {}) {
    const cached = (rows || []).filter(row => row.selfUrl && this._rowIsCached(row));
    if (cached.length === 0) return 0;

    let probe = force;
    if (!probe && feedModified && groupId) {
      if (this._getLastFeedMod(groupId) === feedModified) {
        console.log('[VIEWS] Group feed unchanged — skipping per-form staleness probes');
        return 0;
      }
      probe = true;   // something in this group changed: ask each cached form now
    }

    // A later render owns the DOM now; never paint into its rows.
    const current = () => renderId == null || this._formsRenderId === renderId;

    let staleCount = 0;
    await this._mapLimit(cached, 3, async (row) => {
      try {
        const stale = await this._isFormStale(row.formUrl, row.selfUrl, { force: probe });
        if (!current()) return;

        this._setFormStaleMark(row.formUrl, stale);
        row.stale = stale;
        // Headless checks (the groups screen) pass no button: marks only.
        if (!row.btn) return;
        if (row.btn._dlBusy) return;          // a user download owns the button
        if (stale) {
          staleCount++;
          this._setDownloadBtnStale(row.btn);
        } else if (row.btn._stale) {
          // Badge was orange from a previous run and the server now agrees we
          // are current again (e.g. adopted/RESPECT-refreshed content).
          this._setDownloadBtnCached(row.btn);
        }
      } catch (e) {
        console.warn('[VIEWS] Staleness check failed for', row.formUrl, e.message);
      }
    });

    if (current() && probe && groupId) this._saveLastFeedMod(groupId, feedModified);
    console.log('[VIEWS] Staleness check:', staleCount, 'of', cached.length, 'cached form(s) stale');
    return staleCount;
  },

  /** Run `fn` over items with at most `limit` in flight. */
  async _mapLimit(items, limit, fn) {
    const queue = [...(items || [])];
    if (queue.length === 0) return;
    const workers = Array.from(
      { length: Math.max(1, Math.min(limit, queue.length)) },
      async () => {
        while (queue.length) {
          const item = queue.shift();
          try {
            await fn(item);
          } catch (e) {
            console.warn('[VIEWS] mapLimit task failed:', e);
          }
        }
      }
    );
    await Promise.all(workers);
  },

  /**
   * Update the downloaded forms of a group: refresh the list (publish/unpublish
   * changes), re-check every downloaded form against the server, then download the
   * stale ones only (2 at a time). Forms that are not downloaded are never
   * downloaded, and forms the server says are current are not touched. Each
   * download reuses the same resource discovery as the per-form pin, and the
   * conditional GETs mean unchanged files cost a 304 rather than a full
   * transfer.
   *
   * Driven by the menu's "Update Downloaded Forms" item (`renderHeader`); progress
   * and the outcome are reported by toast and by the download rings on the form rows.
   */
  async _syncForms(groupId, groupName) {
    // 1. Refresh the feed, then reconcile the EXISTING rows in place — no page
    //    reload: new forms are added, unpublished ones removed, titles updated,
    //    and every other row keeps its badge, scroll position and any in-flight
    //    download.
    let forms;
    try {
      forms = await api.getFormsForGroup(groupId, { force: true });
    } catch (e) {
      console.warn('[VIEWS] Sync could not refresh the form list:', e.message);
      this._toast(t('sync.failed'));
      return;
    }
    if (!document.getElementById('form-list')) return;   // user navigated away

    forms.sort((a, b) => {
      const nameA = (a.title || a.name || a.id || '').toLowerCase();
      const nameB = (b.title || b.name || b.id || '').toLowerCase();
      return nameA.localeCompare(nameB);
    });
    this._syncFormList(forms, groupId, document.getElementById('form-list'));

    // 2. Probe every cached form for a newer server copy (forced, so the
    //    result is current even inside the descriptor's max-age window).
    await this._checkFormStaleness(this._formRows, {
      force: true,
      groupId,
      renderId: this._formsRenderId,
    });

    // Rows already downloading (started before this tap) are left alone:
    // _downloadFormResources treats a second call as "cancel this job".
    // Cached-ness is re-derived: a row built before the group was pinned would
    // otherwise still claim `cached: false` and be filtered out here.
    const staleAll = (this._formRows || []).filter(row => this._rowIsCached(row) && row.stale);
    const stale = staleAll.filter(
      row => !this._activeDownloads.has('form:' + row.formUrl)
    );
    // Repaint before deciding: the check above may have just proven the rows
    // current, and they must show that without a re-render.
    (this._formRows || []).forEach(row => this._paintFormRow(row));
    if (staleAll.length === 0) {
      this._toast(t('sync.upToDate'));
      return;
    }
    if (stale.length === 0) {
      // Every stale form is already updating on its own row.
      return;
    }

    // 3. Update the stale forms one by one, on their own row buttons — the
    //    progress ring stays where the form lives in the list.
    let done = 0;
    let failed = 0;
    this._toast(t('sync.progress', { done: 0, total: stale.length }), 1500);
    await this._mapLimit(stale, 2, async (row) => {
      if (this._syncCancelled) return;
      const ok = await this._downloadFormResources(row.formUrl, row.btn);
      if (ok) {
        row.stale = false;
        done++;
      } else {
        failed++;
      }
      this._toast(t('sync.progress', { done: done + failed, total: stale.length }), 1500);
    });

    if (this._syncCancelled) {
      this._toast(t('sync.cancelled'));
      return;
    }
    if (failed === 0) {
      this._toast(t('sync.updated', { count: done }));
    } else {
      this._toast(t('sync.partial', { updated: done, failed }));
    }
  },

  /** Any cached form of this group known to be behind the server? */
  _isGroupStale(groupId) {
    return this._groupCachedFormUrls(groupId)
      .some(formUrl => this._isFormMarkedStale(formUrl));
  },

  /** Every download job that is currently changing this group's offline copy. */
  _groupActiveJobs(groupId) {
    const jobs = [];
    const seen = new Set();
    const add = (job) => {
      if (!job || seen.has(job)) return;
      seen.add(job);
      jobs.push(job);
    };
    add(this._activeDownloads.get('group:' + groupId));
    this._getGroupFormKeys(groupId).forEach((key) => {
      if (key.startsWith('form:')) add(this._activeDownloads.get(key));
    });
    // Forms that were pinned on their own (the group was never pinned) still
    // count while they run: their key is not in cached-group-forms.
    const knownUrls = new Set(this._getGroupKnownFormUrls(groupId));
    for (const [key, job] of this._activeDownloads) {
      if (!key.startsWith('form:')) continue;
      const formUrl = key.substring('form:'.length);
      if (knownUrls.has(formUrl) || key.includes(`/online-survey-apps/${groupId}/`)) add(job);
    }
    return jobs;
  },

  /** Mean of the children's progress; undefined (indeterminate) until all report. */
  _aggregateProgress(jobs) {
    if (!jobs.length) return undefined;
    let sum = 0;
    for (const job of jobs) {
      if (typeof job.progress !== 'number' || !isFinite(job.progress)) return undefined;
      sum += job.progress;
    }
    return sum / jobs.length;
  },

  /** Stop every job touching this group (the group row's tap-to-cancel). */
  _cancelGroupJobs(groupId) {
    this._groupActiveJobs(groupId).forEach((job) => {
      if (!job.signal.cancelled) job.signal.cancelled = true;
    });
    console.log('[VIEWS] Cancelling group update:', groupId);
  },

  /** Which group a `form:<url>` cache key belongs to. */
  _groupIdForFormKey(key) {
    try {
      const map = JSON.parse(localStorage.getItem('cached-group-forms') || '{}');
      for (const groupId of Object.keys(map)) {
        if (Array.isArray(map[groupId]) && map[groupId].includes(key)) return groupId;
      }
    } catch (e) { /* ignore */ }
    const match = String(key).match(/\/online-survey-apps\/([^/]+)\//);
    return match ? match[1] : null;
  },

  /** Repaint a visible group row when one of its child form jobs moved. */
  _refreshGroupBadgeForFormKey(key) {
    if (!key || !key.startsWith('form:')) return;      // group jobs paint themselves
    const groupId = this._groupIdForFormKey(key);
    if (!groupId) return;
    const btn = document.getElementById('download-group-' + groupId);
    if (btn) this._setGroupBadge(btn, groupId);
  },

  // ── Group-level staleness ────────────────────────────────────────────────
  //
  // The groups screen renders instantly from persisted marks, and those are
  // only written by the forms screen. A pinned group whose child was
  // re-published therefore stayed green until its form list was opened — and
  // tapping that green badge UNCACHED the group instead of updating it. These
  // helpers close both gaps: a throttled background check on the list, and a
  // forced check before the uncache branch runs.

  _groupsRenderId: 0,
  _groupCheckedAt: new Map(),        // groupId -> last check (this session only)
  _groupCheckInFlight: new Set(),
  _GROUP_CHECK_INTERVAL_MS: 5 * 60 * 1000,

  /**
   * Background pass over the groups that hold offline content on the groups
   * screen: pinned groups AND groups whose forms were pinned one by one (the
   * feed read here is also what teaches the screen whether such a group is now
   * complete).
   *
   * Cheap by construction: one feed request per group, and per-form probes
   * only when that feed's `metadata.modified` moved since the last check (see
   * `_checkFormStaleness`). Offline it fails silently and the persisted
   * verdicts stay as they are.
   */
  async _checkGroupsStaleness(renderId) {
    const groups = this._groupsWithOfflineContent();
    if (groups.size === 0) return;

    await this._mapLimit([...groups], 2, async (groupId) => {
      try {
        await this._checkOneGroupStaleness(groupId, renderId);
      } catch (e) {
        console.warn('[VIEWS] Group staleness check failed for', groupId, e.message || e);
      }
    });
  },

  /**
   * Groups that hold something offline, however it was pinned: a whole-group
   * pin, a group whose form list we know, or a cached form on its own.
   */
  _groupsWithOfflineContent() {
    const groupIds = new Set();
    try {
      Object.keys(JSON.parse(localStorage.getItem('group-form-urls') || '{}'))
        .forEach(groupId => groupIds.add(groupId));
    } catch (e) { /* ignore */ }
    for (const key of this._cachedItems) {
      if (key.startsWith('group:')) groupIds.add(key.substring('group:'.length));
    }
    for (const key of this._cachedItems) {
      if (!key.startsWith('form:')) continue;
      const match = key.match(/\/online-survey-apps\/([^/]+)\//);
      if (match) groupIds.add(match[1]);
    }
    return groupIds;
  },

  /** Does any form of this group sit on disk, however it was pinned? */
  _groupHasCachedForms(groupId) {
    if (this._isCached('group:' + groupId)) return true;
    if (this._groupCachedFormUrls(groupId).length > 0) return true;
    // A form cached before the group's form list was ever seen is not in any
    // map, but its URL still says which group it belongs to.
    const suffix = `/online-survey-apps/${groupId}/`;
    for (const key of this._cachedItems) {
      if (key.startsWith('form:') && key.includes(suffix)) return true;
    }
    return false;
  },

  /**
   * Re-evaluate one group against the server (pinned as a whole, or holding
   * forms pinned one by one — the feed read here is what records which forms
   * the group holds, and therefore whether the copy is complete).
   *
   * @param {string}  groupId
   * @param {number}  renderId  groups-screen generation that asked for this
   * @param {Object}  [options]
   * @param {boolean} [options.force]   ignore the throttle (user-initiated)
   * @param {boolean} [options.repaint] repaint the group row when done
   * @returns {Promise<boolean>} true when the check actually ran
   */
  async _checkOneGroupStaleness(groupId, renderId, { force = false, repaint = true } = {}) {
    if (!this._groupHasCachedForms(groupId)) return false;
    if (this._activeDownloads.has('group:' + groupId)) return false;
    if (this._groupCheckInFlight.has(groupId)) {
      // A background pass is already asking the server. The list does not care,
      // but a tap does: wait for that answer rather than acting on stale marks.
      if (!force) return false;
      for (let i = 0; i < 50 && this._groupCheckInFlight.has(groupId); i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return !this._groupCheckInFlight.has(groupId);
    }
    if (!force &&
        Date.now() - (this._groupCheckedAt.get(groupId) || 0) < this._GROUP_CHECK_INTERVAL_MS) {
      return false;
    }

    this._groupCheckInFlight.add(groupId);
    try {
      const forms = await api.getFormsForGroup(groupId);
      const feedModified = forms.feedModified || null;

      // Feed-level gate. It moves whenever anything in the group changes —
      // including a publish/unpublish, which is why it is only ever used to
      // SKIP work and never to declare a form stale.
      if (!force && feedModified && this._getLastFeedMod(groupId) === feedModified) {
        console.log('[VIEWS] Group feed unchanged — no staleness probes:', groupId);
        return true;
      }

      const rows = forms.map((form) => {
        const formUrl = this._formUrl(form, groupId);
        return {
          formUrl,
          groupId,
          selfUrl: form._selfUrl || this._publicationDetailUrl(formUrl),
          btn: null,                     // headless: marks only, nothing to paint
        };
      });
      // The feed is the authority on what this group holds — that is what the
      // groups screen needs to know whether the copy is complete.
      this._saveGroupKnownFormUrls(groupId, rows.map(row => row.formUrl));
      await this._checkFormStaleness(rows, { feedModified, groupId });
      return true;
    } finally {
      this._groupCheckInFlight.delete(groupId);
      this._groupCheckedAt.set(groupId, Date.now());
      // Only paint the screen that asked for this check, and only if its row
      // still exists (the user may have navigated into a form list since).
      if (repaint && this._groupsRenderId === renderId) {
        const btn = document.getElementById('download-group-' + groupId);
        if (btn) this._setGroupBadge(btn, groupId);
      }
    }
  },

  /**
   * Paint a group badge from the aggregate state of the group's offline copy:
   *   incomplete  → download icon (nothing, or some of its forms, cached)
   *   complete    → green (children current)
   *   complete + any child stale → orange (update available)
   *
   * "Complete" means the group was pinned as a whole OR every form its list
   * holds was pinned one by one — see `_isGroupFullyCached`. Uses the persisted
   * stale marks, so it needs no network on the groups screen — the marks were
   * produced when the forms screen ran its checks.
   */
  _setGroupBadge(buttonEl, groupId) {
    if (!buttonEl) return;
    // The group's own pin/update job owns the badge.
    if (this._resumeDownloadBadge('group:' + groupId, buttonEl)) return;

    // Children are being refreshed/downloaded one by one (the form list's
    // per-form badges, or forms pinned individually) — that is the same work,
    // so show it here too, even when the copy is not complete yet.
    const jobs = this._groupActiveJobs(groupId);
    if (jobs.length) {
      buttonEl._dlSignal = null;
      buttonEl._dlCancelAll = () => this._cancelGroupJobs(groupId);
      this._setDownloadBtnBusy(buttonEl, this._aggregateProgress(jobs));
      return;
    }

    if (!this._isGroupFullyCached(groupId)) {
      this._setDownloadBtnUncached(buttonEl);
      return;
    }

    if (this._isGroupStale(groupId)) this._setDownloadBtnStale(buttonEl);
    else this._setDownloadBtnCached(buttonEl);
  },

  /**
   * Update only the stale forms of a pinned group (the orange group badge).
   * Unchanged children are not touched, so a group whose single form changed
   * does not re-download everything. Returns true when all updates succeeded.
   */
  async _updateStaleGroupForms(groupId, buttonEl) {
    const key = 'group:' + groupId;
    const staleUrls = this._groupCachedFormUrls(groupId)
      .filter(formUrl => this._isFormMarkedStale(formUrl));

    if (staleUrls.length === 0) {
      this._setGroupBadge(buttonEl, groupId);
      return true;
    }
    if (this._activeDownloads.has(key)) {
      this._cancelDownloadJob(key);
      return false;
    }

    const signal = { cancelled: false };
    this._registerDownload(key, buttonEl.id, signal);

    let done = 0;
    let failed = 0;
    await this._mapLimit(staleUrls, 2, async (formUrl) => {
      if (signal.cancelled) return;
      // No form rows are on screen from the groups list, so the per-form badge
      // helpers get a detached button; progress shows on the group row's ring.
      const ok = await this._downloadFormResources(
        formUrl, document.createElement('button'), { quiet: true }
      );
      if (ok) done++;
      else failed++;
      this._setDownloadProgress(key, (done + failed) / staleUrls.length);
    });

    const btn = this._currentJobButton(key, buttonEl);
    this._activeDownloads.delete(key);
    if (btn) this._setGroupBadge(btn, groupId);
    if (failed > 0 && !this._sessionExpired) {
      this._toast(t('sync.partial', { updated: done, failed }));
    }
    return failed === 0;
  },

  /** Open-access (or release) URL for a form in a group. */
  _formUrl(form, groupId) {
    const formId = form.id;
    return form._openAccessUrl
      ? (form._openAccessUrl.startsWith('http')
          ? form._openAccessUrl
          : `${api.getBaseUrl()}${form._openAccessUrl}`)
      : `${api.getBaseUrl()}/releases/prod/online-survey-apps/${groupId}/${formId}/#/form/${formId}`;
  },

  /** Transient status line (brief feedback for background jobs). */
  _toast(message, ms = 2500) {
    let el = document.getElementById('app-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'app-toast';
      el.className = 'app-toast';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.add('visible');
    clearTimeout(el._timer);
    el._timer = setTimeout(() => el.classList.remove('visible'), ms);
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

  // ── Known form list per group ───────────────────────────────────────────
  //
  // The groups screen has no feed of its own, so it cannot know whether a group
  // is fully offline unless the app remembers which forms the group held the
  // last time its form list was seen. Forms pinned one by one are NOT in
  // `cached-group-forms` (that map belongs to a whole-group pin), so this is
  // what makes "every form cached individually" count as a complete copy.

  _getGroupKnownFormUrls(groupId) {
    try {
      const map = JSON.parse(localStorage.getItem('group-form-urls') || '{}');
      return Array.isArray(map[groupId]) ? map[groupId] : [];
    } catch (e) { return []; }
  },

  _saveGroupKnownFormUrls(groupId, urls) {
    if (!groupId) return;
    try {
      const map = JSON.parse(localStorage.getItem('group-form-urls') || '{}');
      const unique = [...new Set((urls || []).filter(Boolean))];
      if (unique.length) map[groupId] = unique;
      else delete map[groupId];
      localStorage.setItem('group-form-urls', JSON.stringify(map));
    } catch (e) { /* ignore */ }
  },

  /**
   * Does this group have a complete offline copy?
   *
   * True when the group was pinned as a whole, or when every form its list held
   * last time was pinned individually — per-form downloads add up to the same
   * offline copy, so the group badge must show the same state.
   */
  _isGroupFullyCached(groupId) {
    if (this._isCached('group:' + groupId)) return true;
    const urls = this._getGroupKnownFormUrls(groupId);
    return urls.length > 0 && urls.every(url => this._isCached('form:' + url));
  },

  /** Cached form URLs of this group, whichever way they were pinned. */
  _groupCachedFormUrls(groupId) {
    const urls = new Set();
    this._getGroupFormKeys(groupId).forEach((key) => {
      if (key.startsWith('form:')) urls.add(key.substring('form:'.length));
    });
    this._getGroupKnownFormUrls(groupId).forEach(url => urls.add(url));
    return [...urls].filter(url => this._isCached('form:' + url));
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
    // Material `stop` - the glyph RESPECT swaps in (Icons.Default.Stop) while a
    // publication is being fetched, i.e. while a tap cancels the download.
    stop: 'M6 6h12v12H6z',
    // Material `sync` - the header's sync button: two chasing arrows, the
    // universal "make this device current" glyph.
    sync: 'M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z',
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
   * @param {string}   [options.title]           Optional title shown next to the logo (logged-in pages).
   * @param {boolean}  [options.showBack]        Show the back button (logged-in pages).
   * @param {boolean}  [options.loginMode]       Render the login dropdown (Clear saved data only)
   *                                             instead of the logged-in dropdown
   *                                             (RESPECT link / Clear saved data / Logout).
   * @param {boolean}  [options.showSync]        Show the header sync button (form list only).
   * @param {Function} [options.onSync]         Handler that updates this group's downloaded
   *                                             forms; the button also uploads queued
   *                                             responses before calling it.
   */
  renderHeader({ title = '', showBack = false, loginMode = false, showSync = false, onSync = null } = {}) {
    // Remove existing menu bar if any
    const existingMenu = document.getElementById('menu-bar');
    if (existingMenu) existingMenu.remove();

    const menuBar = document.createElement('div');
    menuBar.id = 'menu-bar';
    menuBar.className = 'menu-bar';

    // Left side: (back button) + logo + (DEMO MODE badge) + (title)
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

    // Demo mode is a property of the SERVER the user is pointed at, so the pill
    // is driven by the saved server URL and survives every re-render (login
    // step 2, groups, forms). Step 1 overrides it from its own field, because
    // there the field — not the last saved server — is the selection.
    if (api.isDemoServer(api.getBaseUrl())) {
      menuBar.classList.add('demo-mode');
      menuBar.appendChild(this._createDemoBadge());
    }

    // Right side: (sync) + hamburger toggle + dropdown menu
    const actions = document.createElement('div');
    actions.className = 'menu-actions';

    // Sync lives here rather than in the menu, and only on the form list: it
    // needs a group to update, and it is the one action a field user repeats, so
    // it stays one tap away. A tap while it runs asks it to stop, the same
    // convention the download buttons use.
    if (showSync && typeof onSync === 'function') {
      const syncBtn = document.createElement('button');
      syncBtn.className = 'menu-btn menu-sync';
      syncBtn.id = 'header-sync';
      syncBtn.dataset.baseLabel = t('sync.buttonTitle');
      syncBtn.innerHTML = this._icon('sync') + '<span class="menu-sync-dot" hidden></span>';
      syncBtn.title = t('sync.buttonTitle');
      syncBtn.setAttribute('aria-label', t('sync.buttonTitle'));
      syncBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (syncBtn.classList.contains('is-syncing')) {
          this._syncCancelled = true;
          return;
        }
        this._syncCancelled = false;
        this._onHeaderSync(syncBtn, onSync);
      });
      actions.appendChild(syncBtn);
      // The bar is rebuilt on every navigation, so the dot has to be re-derived
      // here or a fresh render would hide pending work.
      this._refreshSyncDot();
    }

    const menuToggle = document.createElement('button');
    menuToggle.className = 'menu-btn menu-hamburger';    menuToggle.innerHTML = this._icon('menu');
    menuToggle.setAttribute('aria-label', 'Menu');
    actions.appendChild(menuToggle);

    const dropdown = document.createElement('div');
    dropdown.className = 'menu-dropdown';

    if (loginMode) {
      // Login screen: Clear Login History plus About. About belongs here as much
      // as in the logged-in menu — the version is the first thing support asks
      // for, and a user who cannot sign in cannot reach the other menu.
      dropdown.innerHTML = `
        <div class="dropdown-info">
          <span class="dropdown-info-label">${t('menu.loginLabel')}</span>
          <span class="dropdown-info-url">${api.getBaseUrl() ? t('menu.serverPrefix') + api.getBaseUrl() : t('menu.noServerSelected')}</span>
        </div>
        <button class="dropdown-item dropdown-item-clear">${t('menu.clearLoginHistory')}</button>
        <button class="dropdown-item dropdown-item-about">${t('menu.about')}</button>
      `;
      dropdown.querySelector('.dropdown-item-clear').addEventListener('click', () => {
        dropdown.classList.remove('open');
        this.clearLoginHistory();
      });
      dropdown.querySelector('.dropdown-item-about').addEventListener('click', () => {
        dropdown.classList.remove('open');
        this.showAbout();
      });
    } else {
      // Logged-in screen: RESPECT link, Clear Login History, About, Logout.
      // Syncing is the header's job (see `showSync`), so nothing about it is here.
      dropdown.innerHTML = `
        <div class="dropdown-info">
          <span class="dropdown-info-label">${api.getUsername() || 'Unknown'}</span>
          <span class="dropdown-info-url">${api.getBaseUrl() || 'No server'}</span>
        </div>
        <button class="dropdown-item dropdown-item-respect">Copy RESPECT Link</button>
        <button class="dropdown-item dropdown-item-clear">Clear Login History</button>
        <button class="dropdown-item dropdown-item-about">${t('menu.about')}</button>
        <button class="dropdown-item dropdown-item-logout">Logout</button>
      `;
      dropdown.querySelector('.dropdown-item-about').addEventListener('click', () => {
        dropdown.classList.remove('open');
        this.showAbout();
      });
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

  /**
   * About dialog: what this app is, which build is installed, and which
   * server/session it is talking to.
   *
   * The version comes from the installed binary (Capacitor App plugin) rather
   * than a hardcoded string, because the usual reason to open this dialog is a
   * support question where the build number is the first thing asked for.
   */
  async showAbout() {
    document.getElementById('about-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'about-overlay';
    overlay.className = 'about-overlay';
    overlay.innerHTML = `
      <div class="about-card" role="dialog" aria-modal="true" aria-labelledby="about-title">
        <h2 class="about-title" id="about-title"></h2>
        <p class="about-app"></p>
        <dl class="about-rows">
          <dt class="about-version-label"></dt><dd class="about-version"></dd>
          <dt class="about-server-label"></dt><dd class="about-server"></dd>
          <dt class="about-user-label"></dt><dd class="about-user"></dd>
        </dl>
        <button class="about-close" type="button"></button>
      </div>`;

    // Values go in via textContent, not into the template: a server URL or
    // username containing markup must never be rendered as HTML.
    const set = (selector, text) => {
      const el = overlay.querySelector(selector);
      if (el) el.textContent = text;
    };
    set('.about-title', t('about.title'));
    set('.about-app', t('about.appName'));
    set('.about-version-label', t('about.version'));
    set('.about-server-label', t('about.server'));
    set('.about-user-label', t('about.user'));
    set('.about-server', api.getBaseUrl() || t('menu.noServer'));
    set('.about-user', api.getUsername() || t('menu.unknownUser'));
    set('.about-close', t('about.close'));

    // Before sign-in there is no user yet; a "User: Unknown" row would just be
    // noise, so drop the pair rather than print a placeholder.
    if (!api.getUsername()) {
      overlay.querySelector('.about-user-label')?.remove();
      overlay.querySelector('.about-user')?.remove();
    }

    const close = () => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('.about-close').addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    overlay.querySelector('.about-close').focus();

    set('.about-version', await this._appVersion());
  },

  /** Installed app version, e.g. "1.0 (1)". */
  async _appVersion() {
    const plugin = window.Capacitor?.Plugins?.App;
    if (plugin && typeof plugin.getInfo === 'function') {
      try {
        const info = await plugin.getInfo();
        if (info && info.version) {
          return info.build ? `${info.version} (${info.build})` : String(info.version);
        }
      } catch (e) { /* fall back to the packaged version below */ }
    }
    return '1.0';
  },

  /**
   * The DEMO MODE pill shown in the header. Filled accent badge, centred in the
   * bar: the label — not the colour — carries the meaning, so it still reads for
   * colour-blind users and in screenshots. The tooltip names the host, which is
   * always the demo server (the pill only ever describes that one).
   */
  _createDemoBadge() {
    const badge = document.createElement('span');
    badge.className = 'demo-badge';
    badge.textContent = t('common.demoMode');
    badge.title = `${t('common.demoServer')}: ${api.getDemoServer()}`;
    return badge;
  },

  /**
   * Add or remove the header's pill (and its companion `demo-mode` class) in
   * place, without re-rendering the bar.
   *
   * Step 1 needs this: there the pill describes what is in the server field, so
   * emptying the field has to take it away even though the previously connected
   * server is still the demo one.
   */
  updateDemoModeBadge(isDemo) {
    const bar = document.getElementById('menu-bar');
    if (!bar) return;
    const existing = bar.querySelector('.demo-badge');
    bar.classList.toggle('demo-mode', !!isDemo);
    if (!isDemo) {
      if (existing) existing.remove();
      return;
    }
    if (!existing) bar.appendChild(this._createDemoBadge());
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
    // A deliberate logout is not an expiry; background failures from here on
    // should surface normally again.
    this._sessionExpired = false;
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

  /** Minimal HTML escaping for values interpolated into innerHTML templates. */
  _escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },

  /**
   * The server rejected the stored token (401 on an authenticated request).
   *
   * Clear the session but KEEP the server URL, then return to the credentials
   * screen for that same server with the username prefilled — the equivalent of
   * a server-rendered app being redirected to /login when its session expires.
   * Cached forms and pinned URLs are deliberately left alone: they are still
   * readable offline, and re-authenticating restores full use.
   */
  handleSessionExpired() {
    // Already handled, or never signed in. A group pin fires ~140
    // authenticated requests; only the first 401 should move the UI.
    if (!localStorage.getItem('token')) return;
    // A RESPECT launch's Basic credentials are not JWTs: getGroups() upgrades
    // them itself and deliberately falls back to Basic when that fails, so a
    // 401 on them does not mean the session should be discarded.
    if (api._isBasicToken && api._isBasicToken()) return;

    const username = api.getUsername();
    const serverUrl = api.getBaseUrl();
    const notice = t('errors.sessionExpired');
    console.warn('[VIEWS] Session rejected by the server; returning to login');

    this._sessionExpired = true;
    this._history = [];
    this._currentGroupId = null;
    this._currentGroupName = null;
    api.logout();
    this.removeMenuBar();

    // Already on a login screen (e.g. the user tapped "Change" while a stale
    // request was still in flight): keep their input and just explain why.
    const step2Error = document.getElementById('step2-error');
    const step1Error = document.getElementById('step1-error');
    if (step2Error || step1Error) {
      (step2Error || step1Error).textContent = notice;
      return;
    }

    if (serverUrl) {
      this.renderLoginStep2(false, { prefillUsername: username, notice });
      // Overwrite the list's history entry: Back must not return to a screen
      // whose session is gone.
      history.replaceState({ page: 'step2' }, '');
      return;
    }
    this.renderLoginStep1();
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
      if (api.isDemoServer(server)) {
        // The demo hostname reads like jargon on its own, so give it a name.
        // The URL stays visible on a second line: it is the only place the
        // actual host is shown at the moment of choosing, and http vs https
        // has to stay legible.
        item.classList.add('has-sub');
        item.innerHTML =
          `<span class="suggest-item-label">${this._escapeHtml(t('common.demoServer'))}</span>` +
          `<span class="suggest-item-sub">${this._escapeHtml(server)}</span>`;
      } else {
        item.textContent = server;
      }
      item.title = server;
      item.addEventListener('click', () => {
        // Validate like a typed URL: a remembered server may be stale or may
        // point at an older Tangerine. Keep the choice in the field so the
        // user can correct it if the check fails.
        input.value = server;
        // A programmatic assignment fires no `input` event, so sync the pill
        // here rather than relying on the field's listener.
        this.updateDemoModeBadge(api.isDemoServer(server));
        list.classList.remove('open');
        this._connectToServer(server);
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
   * text field, and fill the demo password when the demo user is chosen.
   *
   * The list itself only ever contains `appuser` while the selected server is
   * the demo server (see api.getRecentUsernames), and api.getDemoPassword
   * re-checks both the username and the current base URL, so the demo password
   * can never be filled in for another server.
   */
  _renderRecentUsernames() {
    const input = document.getElementById('username');
    const list = document.getElementById('username-suggest-list');
    if (!input || !list) return;
    const passwordInput = document.getElementById('password');

    // Deliberately never reacts to what is typed: `appuser` is a prefix of
    // names like `appuser1`, so filling on keystrokes would flash the demo
    // password into the field for a user who never asked for it, and clearing
    // on later edits would silently empty a field the user was not touching.
    // The password is filled only when `appuser` is chosen from this list, and
    // is never removed afterwards — the user picked it, so the user controls it.
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
        if (passwordInput) {
          const demoPassword = api.getDemoPassword(username);
          if (demoPassword) passwordInput.value = demoPassword;
          passwordInput.focus();
        }
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

  /**
   * Validate the entered server URL against the server before moving on to
   * the credentials screen. `/respect-app-manifest` exists on every Tangerine
   * version that supports this app, so a 404 means the URL is wrong or the
   * server is an older Tangerine — either way, say so here rather than
   * failing later at login.
   */
  async _connectToServer(rawUrl) {
    const errorEl = document.getElementById('step1-error');
    const button = document.getElementById('connect-btn');
    const url = String(rawUrl || '').trim();
    if (errorEl) errorEl.textContent = '';

    if (!url) {
      if (errorEl) errorEl.textContent = t('errors.serverRequired');
      return;
    }

    const originalLabel = button ? button.textContent : '';
    if (button) {
      button.disabled = true;
      button.textContent = t('login.checking');
    }

    let result;
    try {
      result = await api.checkServer(url);
    } catch (e) {
      console.warn('[VIEWS] Server check failed:', e);
      result = { ok: false, reason: 'unreachable' };
    }

    if (result.ok) {
      api.setBaseUrl(url);
      this.renderLoginStep2();
      return;
    }

    if (button) {
      button.disabled = false;
      button.textContent = originalLabel || t('login.connect');
    }
    if (errorEl) {
      errorEl.textContent = result.reason === 'unreachable'
        ? t('errors.serverUnreachable')
        : result.reason === 'invalid'
          ? t('errors.serverInvalidUrl')
          : t('errors.serverNotTangerine');
    }
  },

  renderLoginStep1(pushHistory = true) {
    this.renderHeader({ loginMode: true });
    const container = document.getElementById('page-container');
    // First launch (nothing remembered) would show an empty field, leaving the
    // always-available demo server reachable only through the suggestion list.
    // Prefill its URL instead: it is a real, validated target, and the user can
    // still overwrite it with their own server.
    const initialServer = api.getBaseUrl() || api.getDemoServer();
    container.innerHTML = `
      <div class="screen" id="login-step1">
        <div class="card">
          <img src="img/logo-login.png" alt="Tangerine" class="login-logo">
          <h1>Enter your server URL</h1>
          <div class="input-suggest input-clearable">
            <input type="text" id="server-url" aria-label="Server URL" placeholder="https://your-server.com" value="${this._escapeHtml(initialServer)}" autocomplete="off">
            <button type="button" class="input-clear" id="clear-server-url" data-clear-for="server-url" aria-label="Clear server URL" title="Clear">${this._icon('close', 'clear-icon')}</button>
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
      this._connectToServer(document.getElementById('server-url').value);
    });
    this._renderRecentServers();
    // On this screen the field IS the selection, so the pill follows it: typing
    // the demo URL shows DEMO MODE, clearing the field takes it away — even when
    // the saved server is still the demo one. Focus is not enough of a trigger;
    // the pill must also disappear when the clear (X) button empties the field,
    // which dispatches `input`.
    const serverInput = document.getElementById('server-url');
    const syncDemoBadge = () => this.updateDemoModeBadge(api.isDemoServer(serverInput.value));
    serverInput.addEventListener('input', syncDemoBadge);
    syncDemoBadge();
    this._wireClearButtons(container);
  },

  renderLoginStep2(pushHistory = true, { prefillUsername = '', notice = '' } = {}) {
    this.renderHeader({ loginMode: true });
    const container = document.getElementById('page-container');
    const serverUrl = api.getBaseUrl();
    container.innerHTML = `
      <div class="screen" id="login-step2">
        <div class="card">
          <img src="img/logo-login.png" alt="Tangerine" class="login-logo">
          <div class="server-info">
            <label>Server:</label>
            <span id="server-display">${this._escapeHtml(serverUrl)}</span>
            <button id="change-server-btn" class="link-btn">Change</button>
          </div>
          <form id="login-form">
          <div class="input-suggest input-clearable">
            <input type="text" id="username" aria-label="Username" placeholder="Username" autocomplete="off" value="${this._escapeHtml(prefillUsername)}">
            <button type="button" class="input-clear" id="clear-username" data-clear-for="username" aria-label="Clear username" title="Clear">${this._icon('close', 'clear-icon')}</button>
            <div class="suggest-list" id="username-suggest-list"></div>
          </div>
          <div class="input-clearable">
            <input type="password" id="password" aria-label="Password" placeholder="Password" autocomplete="current-password">
            <button type="button" class="input-clear" id="clear-password" data-clear-for="password" aria-label="Clear password" title="Clear">${this._icon('close', 'clear-icon')}</button>
          </div>
            <button type="submit" id="login-btn">Login</button>
          </form>
          <div id="step2-error" class="error">${this._escapeHtml(notice)}</div>
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
        this._sessionExpired = false;
        this.renderGroups();
      } catch (err) {
        document.getElementById('step2-error').textContent = err.message;
      }
    });
    this._renderRecentUsernames();
    this._prefillDemoCredentials();
    this._wireClearButtons(container);
  },

  /**
   * Wire the "X" buttons that sit inside the login fields.
   *
   * Visibility needs no state: the CSS hides the button while the field shows
   * its placeholder, so prefills (demo server/user, session-expiry username)
   * and typing both behave without bookkeeping here. All that is needed is the
   * click: empty the field, keep the caret in it so typing can continue, and
   * fire `input` so listeners (the DEMO MODE badge) see the new value.
   */
  _wireClearButtons(root) {
    if (!root) return;
    root.querySelectorAll('.input-clear').forEach((btn) => {
      btn.addEventListener('click', () => {
        const input = document.getElementById(btn.dataset.clearFor);
        if (!input) return;
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus();
      });
    });
  },

  /**
   * Fill the demo username and password on the credentials screen when the
   * chosen server is the demo server and the user has not entered anything
   * yet. Never overwrites input: a remembered username (session-expiry bounce)
   * or anything the user typed is left alone.
   */
  _prefillDemoCredentials() {
    const usernameInput = document.getElementById('username');
    const passwordInput = document.getElementById('password');
    if (!usernameInput || !passwordInput) return;
    if (usernameInput.value || passwordInput.value) return;
    const demo = api.getDemoCredentials();
    if (!demo) return;
    usernameInput.value = demo.username;
    passwordInput.value = demo.password;
  },

  /**
   * Show an indeterminate spinner plus a label inside `host` and return the
   * element, so the caller can remove it once the request settles.
   *
   * `host` must be the visible `.screen` box, not the page container: the screen
   * is at least a viewport tall, so a sibling appended after it would sit below
   * the fold.
   *
   * The list screens are painted before their feed resolves (heading + empty
   * <ul>), so without this a slow or hanging feed is indistinguishable from an
   * empty list. `role="status"` makes the label announce itself without moving
   * focus, and it is real text so the state is readable and testable.
   */
  _showLoading(host, label) {
    const el = document.createElement('div');
    el.className = 'loading';
    el.setAttribute('role', 'status');
    el.innerHTML =
      '<span class="loading-spinner" aria-hidden="true"></span>' +
      `<span class="loading-label">${this._escapeHtml(label)}</span>`;
    host.appendChild(el);
    return el;
  },

  async renderGroups({ skipHistory = false, force = false } = {}) {
    // Push browser history entry so back button fires popstate
    if (!skipHistory && this._history.length === 0) {
      history.pushState({ page: 'groups' }, '');
    }
    // Generation counter: a background staleness check must not paint into a
    // later render of this screen (goBack() re-renders it).
    const renderId = (this._groupsRenderId = (this._groupsRenderId || 0) + 1);
    const container = document.getElementById('page-container');
    container.innerHTML = `<div class="screen" id="groups"><h1>Groups</h1><ul id="group-list"></ul></div>`;
    this.renderHeader({ title: 'Groups', showBack: true });
    // Captured, not re-queried: a feed that resolves after the user navigated
    // away must write into this (detached) screen, never into a null DOM id.
    const screen = container.querySelector('.screen');
    const list = document.getElementById('group-list');
    // Painted before the feed resolves: say so, rather than showing an empty list.
    const loading = this._showLoading(screen, t('pages.loadingGroups'));
    try {
      const groups = await api.getGroups({ force });
      loading.remove();
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
        dlBtn.dataset.baseTitle = t('pages.pinGroup');
        dlBtn.title = dlBtn.dataset.baseTitle;
        // Green = pinned and all its cached forms are current; orange = pinned
        // but at least one cached form has an update available. A running job
        // keeps its progress ring across re-renders.
        this._setGroupBadge(dlBtn, groupId);
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
        screen.insertAdjacentHTML('beforeend', '<div class="error">No groups found</div>');
      }

      // Background: bring the pinned groups' badges up to date. One small feed
      // request per pinned group; per-form probes only when that feed moved.
      this._checkGroupsStaleness(renderId).catch(() => {});
    } catch (err) {
      console.log('[VIEWS] renderGroups error:', err);
      loading.remove();
      // Inside the screen, not the page container: see _showLoading.
      screen.insertAdjacentHTML('beforeend', `<div class="error">${err.message}</div>`);
    }
  },

  async renderForms(groupId, groupName, { forceList = false, forceDetail = false } = {}) {
    // Generation counter: async badge work from an older render must never
    // paint into the rows of the current one (that is what made the badge
    // appear to flip between states).
    const renderId = (this._formsRenderId = (this._formsRenderId || 0) + 1);
    const container = document.getElementById('page-container');
    container.innerHTML = `<div class="screen" id="forms"><h1>Forms - ${groupName}</h1><ul id="form-list"></ul></div>`;
    // The "Update Forms" menu item exists ONLY here: it needs a group to work
    // on, so the groups list (and every other page) does not offer it.
    this.renderHeader({
      title: `Forms - ${groupName}`,
      showBack: true,
      showSync: true,
      onSync: () => this._syncForms(groupId, groupName),
    });
    const screen = container.querySelector('.screen');
    const list = document.getElementById('form-list');
    // Same as the group list: the feed is a network round trip, so show progress.
    const loading = this._showLoading(screen, t('pages.loadingForms'));
    try {
      console.log('[VIEWS] renderForms called with:', { groupId, groupName });
      const forms = await api.getFormsForGroup(groupId, { force: forceList });
      loading.remove();
      console.log('[VIEWS] renderForms received:', forms);
      // Sort forms alphabetically by form name
      forms.sort((a, b) => {
        const nameA = (a.title || a.name || a.id || '').toLowerCase();
        const nameB = (b.title || b.name || b.id || '').toLowerCase();
        return nameA.localeCompare(nameB);
      });
      // Remember what this group holds: the groups screen needs it to tell a
      // complete offline copy made form by form from a missing one.
      this._saveGroupKnownFormUrls(groupId, forms.map(form => this._formUrl(form, groupId)));
      // Rows for stale-cache checking / Sync. Rebuilt on every render so a
      // background job always writes into the screen that is actually shown.
      this._formRows = [];
      const reconcilePromises = [];

      forms.forEach(form => {
        const built = this._buildFormRow(form, groupId);
        reconcilePromises.push(built.reconcile);
        list.appendChild(built.li);
      });
      if (forms.length === 0) {
        screen.insertAdjacentHTML('beforeend', '<div class="error">No forms found for this group</div>');
      }

      // Fire-and-forget: mark cached forms whose server copy is newer with the
      // orange "update available" badge. Sync awaits this promise.
      const rowsForCheck = this._formRows;
      this._stalenessCheck = Promise.all(reconcilePromises)
        .then(() => this._checkFormStaleness(rowsForCheck, {
          force: forceDetail,
          feedModified: forms.feedModified || null,
          groupId,
          renderId,
        }))
        .catch(e => console.warn('[VIEWS] Staleness check failed:', e));
    } catch (err) {
      console.log('[VIEWS] renderForms error:', err);
      loading.remove();
      // Inside the screen, not the page container: see _showLoading.
      screen.insertAdjacentHTML('beforeend', `<div class="error">${err.message}</div>`);
    }
  },

  /**
   * Is this row's content actually on disk — its own pin, or its group's?
   *
   * Deliberately derived instead of stored: a row outlives many state changes
   * (a group pin marks every child cached without touching the rows, a
   * background check flips a mark), so a value captured at build time goes
   * stale and nothing would ever repaint it.
   */
  _rowIsCached(row) {
    return !!row &&
      (this._isCached('form:' + row.formUrl) || this._isCached('group:' + row.groupId));
  },

  /** Repaint the form rows of `groupId` (they mirror group-level state too). */
  _refreshFormRowsForGroup(groupId) {
    if (!groupId || !Array.isArray(this._formRows)) return;
    this._formRows.forEach((row) => {
      if (row.groupId === groupId) this._paintFormRow(row);
    });
  },

  /**
   * Paint one form row's badge from the CURRENT state.
   *
   * Order matters: the row's own download job owns the badge, then a
   * whole-group download (which has no per-form job but is downloading this
   * form too), then the settled cached/stale/uncached states.
   */
  _paintFormRow(row) {
    if (!row || !row.btn) return;
    const btn = row.btn;
    const formKey = 'form:' + row.formUrl;

    if (btn._dlBusy && !btn._groupBusy) return;    // its own job owns the ring
    if (!btn._dlBusy && this._resumeDownloadBadge(formKey, btn)) return;

    const groupId = row.groupId;
    const formCached = this._isCached(formKey);
    const cached = formCached || this._isCached('group:' + groupId);
    row.cached = cached;

    // Group download in progress: this form has no job of its own yet, but it
    // IS being fetched, so show the group's progress here (and let a tap stop
    // the whole group, exactly like the group row does).
    const groupJob = groupId ? this._activeDownloads.get('group:' + groupId) : null;
    if (!formCached && groupJob) {
      btn._dlSignal = null;
      btn._groupBusy = true;
      btn._dlCancelAll = () => this._cancelGroupJobs(groupId);
      this._setDownloadBtnBusy(btn, groupJob.progress);
      return;
    }

    if (!cached) {
      this._setDownloadBtnUncached(btn);
    } else if (this._isFormMarkedStale(row.formUrl)) {
      this._setDownloadBtnStale(btn);
    } else {
      this._setDownloadBtnCached(btn);
    }
  },

  /**
   * Build one list row (li + download button) for a form and register it in
   * `this._formRows`. Shared by the initial render and Sync's in-place
   * reconciliation, so a sync-added row looks and behaves exactly like any
   * other.
   *
   * @returns {{li: HTMLElement, row: Object, reconcile: Promise}}
   */
  _buildFormRow(form, groupId) {
    const formName = form.title || form.name || form.id || 'Unnamed Form';
    const formId = form.id;
    const formUrl = this._formUrl(form, groupId);

    const li = document.createElement('li');
    li.className = 'list-item';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'list-item-name';
    nameSpan.textContent = formName;
    li.appendChild(nameSpan);

    const dlBtn = document.createElement('button');
    dlBtn.className = 'download-btn';
    dlBtn.id = 'download-form-' + formId;
    dlBtn.dataset.baseTitle = t('pages.pinForm');
    dlBtn.title = dlBtn.dataset.baseTitle;

    const isCached = this._rowIsCached({ formUrl, groupId });
    dlBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._onDownloadBtnClick(dlBtn, () => this.cacheFormResources(formUrl, dlBtn));
    });
    li.appendChild(dlBtn);

    li.addEventListener('click', () => this.openFormInWebView(formUrl));

    const row = {
      form,
      formId,
      formUrl,
      groupId,
      nameEl: nameSpan,
      // The listing's publication detail URL (rel=self). Fall back to the URL
      // derived from the release path if the server omitted it.
      selfUrl: form._selfUrl || this._publicationDetailUrl(formUrl),
      btn: dlBtn,
      cached: isCached,
      stale: this._isFormMarkedStale(formUrl),
    };
    this._formRows.push(row);

    // Paint from the current state — never from a value captured here, so a
    // group pin / staleness mark that lands later can still reach this row.
    this._paintFormRow(row);

    // Adoption probe: a shell already on disk (e.g. downloaded by RESPECT)
    // turns the download icon into the cached/stale badge.
    const reconcile = this._reconcileFormBadge(dlBtn, formUrl, groupId);
    return { li, row, reconcile };
  },

  /**
   * Reconcile the rendered list with a freshly fetched feed, in place: add rows
   * for newly published forms, drop rows for unpublished ones, update titles,
   * and leave everything else (badges, scroll, in-flight downloads) alone.
   */
  _syncFormList(forms, groupId, list) {
    const wantedUrls = new Set(forms.map(form => this._formUrl(form, groupId)));
    // The feed just told us exactly which forms this group holds.
    this._saveGroupKnownFormUrls(groupId, [...wantedUrls]);

    // Drop rows the server no longer lists (unpublished/removed forms).
    for (const row of [...this._formRows]) {
      if (wantedUrls.has(row.formUrl)) continue;
      const li = row.btn.closest('li');
      if (li) li.remove();
      this._formRows = this._formRows.filter(r => r !== row);
      this._setFormStaleMark(row.formUrl, false);
    }

    // Walk the feed in its sorted order and place each row accordingly.
    let anchor = null;
    forms.forEach(form => {
      const formUrl = this._formUrl(form, groupId);
      const title = form.title || form.name || form.id || 'Unnamed Form';
      let row = this._formRows.find(r => r.formUrl === formUrl);

      let li;
      if (row) {
        if (row.nameEl && row.nameEl.textContent !== title) {
          row.nameEl.textContent = title;
        }
        row.form = form;
        row.selfUrl = form._selfUrl || this._publicationDetailUrl(formUrl);
        li = row.btn.closest('li');
      } else {
        const built = this._buildFormRow(form, groupId);
        li = built.li;
        row = built.row;
      }

      if (!li) return;
      const target = anchor ? anchor.nextSibling : list.firstChild;
      if (target !== li) list.insertBefore(li, target);
      anchor = li;
    });

    // Keep the empty-state message in step with the feed.
    const screen = document.getElementById('forms');
    const emptyMsg = screen && Array.from(screen.querySelectorAll('.error'))
      .find(el => el.textContent.includes('No forms'));
    if (forms.length === 0 && !emptyMsg && screen) {
      screen.insertAdjacentHTML('beforeend', '<div class="error">No forms found for this group</div>');
    } else if (forms.length > 0 && emptyMsg) {
      emptyMsg.remove();
    }

    // Badges of the surviving rows are re-derived here: a group pin or a
    // background staleness check may have changed what they should show since
    // they were built, and nothing else would repaint them.
    (this._formRows || []).forEach(row => this._paintFormRow(row));
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
          ipcPackage: ipcPackage,
          // The overlay has its own native toolbar, so the header's badge has to
          // be handed to it explicitly — demo mode belongs to the server, not to
          // the screen we came from.
          demoMode: api.isDemoServer(api.getBaseUrl()),
          demoModeLabel: t('common.demoMode')
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
   *
   * A STALE form (orange badge) is a third case: tapping it must download the
   * newer server copy, not uncache it — so the toggle only uncaches when the
   * badge is a settled (green) cached state.
   */
  async cacheFormResources(formUrl, buttonEl) {
    const cacheKey = 'form:' + formUrl;

    // Toggle — already cached and NOT stale: uncache it.
    if (this._isCached(cacheKey) && !buttonEl._stale) {
      console.log('[VIEWS] Uncaching form:', formUrl);
      this._setDownloadBtnBusy(buttonEl);
      try {
        await this._evictUrls(this._getPinnedUrls(cacheKey));
        this._unmarkCached(cacheKey);
        this._removePinnedUrls(cacheKey);
        // An uncached form must not keep a stale mark, or its group would stay
        // orange even though there is nothing left to update.
        this._setFormStaleMark(formUrl, false);
        this._setDownloadBtnUncached(buttonEl);
        // One form fewer: the group's copy may no longer be complete, so its
        // row must stop showing a green check.
        this._refreshGroupBadgeForFormKey(cacheKey);
        console.log('[VIEWS] Uncached form:', formUrl);
      } catch (err) {
        console.error('[VIEWS] Failed to uncache form:', err);
        this._setDownloadBtnCached(buttonEl);
      }
      return;
    }

    return this._downloadFormResources(formUrl, buttonEl);
  },

  /**
   * Remember the version we now hold (so the orange badge clears and the next
   * probe compares content versions), and drop the persisted stale mark.
   */
  async _recordFormVersionAfterUpdate(formUrl) {
    this._setFormStaleMark(formUrl, false);
    try {
      // Forced: the descriptor we just downloaded from may still be a fresh-
      // cached copy, and recording a stale version would keep the badge orange.
      const manifest = await api.getFormManifest(this._publicationDetailUrl(formUrl), { force: true });
      const modified = manifest && manifest.metadata && manifest.metadata.modified;
      if (modified) this._saveFormKnownVersion(formUrl, modified);
      const signature = this._formSignature(manifest);
      if (signature) this._saveFormSignature(formUrl, signature);
    } catch (e) {
      console.warn('[VIEWS] Could not record form version:', formUrl, e.message);
    }
  },

  /**
   * Download (or refresh) a form's resources and mark it cached. Never evicts.
   * Used by the pin toggle when not cached, by a tap on a stale badge, and by
   * the list Sync action.
   *
   * @param {Object}  [options]
   * @param {boolean} [options.quiet] Suppress the "could not cache" alert
   *        (Sync reports its own summary).
   * @returns {Promise<boolean>} true when the form is cached afterwards.
   */
  async _downloadFormResources(formUrl, buttonEl, { quiet = false } = {}) {
    const key = 'form:' + formUrl;
    const cacheKey = key;

    // A tap on a row that was re-rendered while the job runs is a cancel, not a
    // second download of the same form.
    if (this._activeDownloads.has(key)) {
      this._cancelDownloadJob(key);
      return false;
    }

    const wasStale = !!buttonEl._stale;
    const signal = { cancelled: false };
    this._registerDownload(key, buttonEl.id, signal);

    const finish = (apply) => {
      const btn = this._currentJobButton(key, buttonEl);
      this._activeDownloads.delete(key);
      if (btn) apply(btn);
      this._refreshGroupBadgeForFormKey(key);
    };
    const restoreBadge = () => finish((btn) => {
      if (wasStale) this._setDownloadBtnStale(btn);
      else this._setDownloadBtnUncached(btn);
    });

    try {
      const baseUrl = formUrl.replace(/#.*$/, '');
      const urlsToCache = await this._discoverAllFormResourceUrls(formUrl, baseUrl);
      console.log('[VIEWS] Pinning form resources via TangyCache:', urlsToCache.length, 'URLs');
      const result = await cacheService.downloadAndRetain(
        urlsToCache.map(url => ({ url, remark: 'form-cache' })),
        (done, total) => this._setDownloadProgress(key, total ? done / total : 0),
        signal,
        { force: true }   // bypass fresh copies: an update must fetch the new bytes
      );
      console.log('[VIEWS] Pin result:', result.cached, 'cached,', result.failed, 'failed');

      if (result.cancelled) {
        console.log('[VIEWS] Form pin cancelled; nothing marked as cached.');
        restoreBadge();
        return false;
      }
      // Only mark the form cached when content actually landed on disk.
      // A false tick on failure (e.g. offline) would ALSO make the next
      // connected tap UNCACHE instead of cache (this button is a toggle).
      const baseCached = (await this._urlIsCached(baseUrl)) || result.urls.includes(baseUrl);
      if (result.cached > 0 && baseCached) {
        this._markCached(cacheKey);
        this._savePinnedUrls(cacheKey, result.urls);
        // Remember what we now hold, then paint green (this also clears the
        // orange "update available" state and its tooltip).
        await this._recordFormVersionAfterUpdate(formUrl);
        finish((btn) => this._setDownloadBtnCached(btn));
        return true;
      }
      console.warn('[VIEWS] Pin did not cache anything (offline?); leaving badge as-is.');
      restoreBadge();
      // A 401 already sent the user back to the login screen; a modal about
      // caching would only be noise on top of it.
      if (!quiet && !this._sessionExpired) {
        alert('Could not cache this form for offline use. Check your connection and try again.');
      }
      return false;
    } catch (err) {
      console.error('[VIEWS] Failed to pin form:', err);
      restoreBadge();
      if (!quiet && !this._sessionExpired) {
        alert('Could not cache this form for offline use: ' + ((err && err.message) || err));
      }
      return false;
    }
  },

  /**
   * Group badge tap:
   *   no complete copy → pin the whole group
   *   complete + up to date → uncache the group (existing toggle behaviour)
   *   complete + stale child → update ONLY the stale forms, leaving the rest of
   *                            the offline copy untouched
   *
   * "Complete" includes a group whose forms were all pinned one by one; a tap
   * on its green badge then uncaches those forms, exactly like a group pin.
   */
  async cacheGroupResources(groupId, buttonEl) {
    const cacheKey = 'group:' + groupId;

    // Complete but something inside is behind the server: update those forms.
    if (this._isGroupFullyCached(groupId) && this._isGroupStale(groupId)) {
      console.log('[VIEWS] Group has stale forms; updating those only:', groupId);
      await this._updateStaleGroupForms(groupId, buttonEl);
      return;
    }

    // Toggle — already cached. Verify BEFORE evicting: this screen renders from
    // persisted marks, so a group whose children are behind but not yet
    // detected would otherwise be wiped by this tap instead of updated.
    if (this._isGroupFullyCached(groupId)) {
      this._setDownloadBtnBusy(buttonEl);        // indeterminate ring: "checking"
      const verified = await this._checkOneGroupStaleness(
        groupId, this._groupsRenderId, { force: true, repaint: false }
      ).catch((e) => {
        // Offline or server error: we cannot know, so fall through to the
        // explicit meaning of a tap on a pinned (green) group — unpin it.
        console.warn('[VIEWS] Pre-uncache group check failed:', e.message || e);
        return false;
      });
      if (verified && this._isGroupStale(groupId)) {
        console.log('[VIEWS] Group has stale forms; updating those only:', groupId);
        this._clearDownloadBusy(buttonEl);
        await this._updateStaleGroupForms(groupId, buttonEl);
        return;
      }
      console.log('[VIEWS] Uncaching group:', groupId);
      // Eviction is a single native call, so there is no signal to cancel with;
      // _cancelDownload no-ops and taps are ignored while _dlBusy is set.
      this._setDownloadBtnBusy(buttonEl);
      try {
        // Every child form held offline, whether it was pinned with the group
        // or one by one (the later are not in cached-group-forms).
        const childKeys = new Set(this._getGroupFormKeys(groupId));
        this._groupCachedFormUrls(groupId).forEach(url => childKeys.add('form:' + url));

        // Evict every URL pinned for the group or any of its child forms.
        const urlsToEvict = [...this._getPinnedUrls(cacheKey)];
        childKeys.forEach(k => {
          urlsToEvict.push(...this._getPinnedUrls(k));
        });

        await this._evictUrls(urlsToEvict);

        this._unmarkCached(cacheKey);
        childKeys.forEach(k => {
          this._unmarkCached(k);
          this._removePinnedUrls(k);
        });
        this._removePinnedUrls(cacheKey);
        this._removeGroupFormKeys(groupId);
        // The group still holds these forms per the feed, so the inventory is
        // kept: the badge simply shows the download icon again.
        this._setDownloadBtnUncached(buttonEl);
        console.log('[VIEWS] Uncached group:', groupId);
      } catch (err) {
        console.error('[VIEWS] Failed to uncache group:', err);
        this._setGroupBadge(buttonEl, groupId);
      }
      return;
    }

    // Spins while each form's resources are discovered (the slow phase for a
    // group), then tracks cached/total across the whole flattened URL set.
    const key = 'group:' + groupId;
    if (this._activeDownloads.has(key)) {
      this._cancelDownloadJob(key);
      return;
    }
    const signal = { cancelled: false };
    this._registerDownload(key, buttonEl.id, signal);

    const finish = (apply) => {
      const btn = this._currentJobButton(key, buttonEl);
      this._activeDownloads.delete(key);
      if (btn) apply(btn);
      // The rows of this group were showing the group's ring; settle them now.
      this._refreshFormRowsForGroup(groupId);
    };

    try {
      const forms = await api.getFormsForGroup(groupId);
      console.log('[VIEWS] Pinning group forms:', forms.length);

      const allUrls = [];
      const childFormKeys = [];
      for (const form of forms) {
        if (signal.cancelled) {
          console.log('[VIEWS] Group pin cancelled during discovery.');
          finish((btn) => this._setDownloadBtnUncached(btn));
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
        (done, total) => this._setDownloadProgress(key, total ? done / total : 0),
        signal,
        { force: true }
      );
      console.log('[VIEWS] Pin result:', result.cached, 'cached,', result.failed, 'failed');

      if (result.cancelled) {
        console.log('[VIEWS] Group pin cancelled; nothing marked as cached.');
        finish((btn) => this._setDownloadBtnUncached(btn));
        return;
      }

      childFormKeys.forEach(k => this._markCached(k));
      this._markCached(cacheKey);
      this._savePinnedUrls(cacheKey, result.urls);
      this._saveGroupFormKeys(groupId, childFormKeys);
      this._saveGroupKnownFormUrls(groupId, childFormKeys.map(k => k.substring('form:'.length)));
      // Record each form's content version so the badges start green and a
      // later re-release is measured against the right baseline.
      for (const k of childFormKeys) {
        if (k.startsWith('form:')) {
          await this._recordFormVersionAfterUpdate(k.substring('form:'.length));
        }
      }
      finish((btn) => this._setDownloadBtnCached(btn));
    } catch (err) {
      console.error('[VIEWS] Failed to pin group:', err);
      const btn = this._currentJobButton(key, buttonEl) || buttonEl;
      this._activeDownloads.delete(key);
      this._clearDownloadBusy(btn);
      btn.textContent = '✗';
      btn.style.color = '#ff0000';
      btn.setAttribute('aria-label', 'Download failed');
      btn.removeAttribute('aria-busy');
      setTimeout(() => {
        this._setDownloadBtnUncached(btn);
      }, 2000);
      // Rows of this group were showing its ring; fall back to their own state.
      this._refreshFormRowsForGroup(groupId);
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
    // One-time migration: badges recorded before the content check existed were
    // derived from metadata.modified alone, which a publish/unpublish bumps for
    // every form in the group. Drop those (often false) marks and the baselines
    // they were compared against; everything is recomputed on the next render.
    try {
      if (!localStorage.getItem('stale-cache-v2')) {
        localStorage.removeItem('stale-form-urls');
        localStorage.removeItem('cached-form-version');
        localStorage.removeItem('cached-form-signature');
        localStorage.removeItem('last-form-feed-mod');
        localStorage.setItem('stale-cache-v2', '1');
      }
    } catch (e) { /* ignore */ }

    // An AUTHENTICATED request rejected with 401 means the stored token is no
    // longer accepted (expired JWT, revoked account, changed password). Bounce
    // the user back to the credentials screen rather than leaving a dead list.
    httpClient.setUnauthorizedHandler(() => this.handleSessionExpired());

    // A queued response makes the sync button earn its dot, and the queue can
    // change without any app-side action: the plugin drains on reconnect, and a
    // submission is queued inside the native form overlay. Re-check on reconnect
    // and whenever the app returns to the foreground.
    window.addEventListener('online', () => this._refreshSyncDot());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this._refreshSyncDot();
    });

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