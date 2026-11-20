package com.tangy.cache

import android.annotation.SuppressLint
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Build
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ImageView
import android.widget.ProgressBar
import android.widget.TextView

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Environment
import android.provider.MediaStore
import android.provider.Settings
import android.webkit.GeolocationPermissions
import android.webkit.ConsoleMessage
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.ActivityResult
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.openeel.libcache.ipc.client.HttpIpcClient
import org.openeel.libcache.ipc.client.HttpIpcClientBuilder
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

data class CacheMeta(
    val url: String,
    val mimeType: String,
    val headers: Map<String, String>,
    val storedAt: Long,
    val sizeBytes: Long
)

data class PinJob(
    val jobId: String,
    val urls: List<String>,
    val createdAt: Long
)

data class PendingSubmission(
    val id: String,
    val url: String,
    val method: String,
    val headers: Map<String, String>,
    val body: String,
    val createdAt: Long
)

@CapacitorPlugin(name = "TangyCache")
class TangyCachePlugin : Plugin() {

    private val gson = Gson()
    private val scope = CoroutineScope(Dispatchers.IO)
    private val pinJobs = ConcurrentHashMap<String, PinJob>()

    // Serialises drains of the offline submission queue. The connectivity
    // callback (auto-upload on reconnect) and the menu's "Upload Responses"
    // action can fire at any moment, and a response POSTed twice is a duplicate
    // record on the server. Together with the per-file `.sending` rename in
    // claimPending() this makes every submission at-most-once.
    private val pendingDrainLock = java.util.concurrent.atomic.AtomicBoolean(false)

    // URLs with a background cache-refresh already in flight (dedupes the
    // fire-and-forget refreshes kicked off from shouldInterceptRequest so a
    // repeated open never piles up duplicate network calls for one resource).
    private val backgroundRefreshInFlight = ConcurrentHashMap<String, Boolean>()

    private var proxyServer: CacheProxyServer? = null
    private var connectivityCallback: ConnectivityManager.NetworkCallback? = null

    // ── WebView camera / mic / geolocation / file-capture support ─────────
    private var permissionLauncher: ActivityResultLauncher<Array<String>>? = null
    private var fileChooserLauncher: ActivityResultLauncher<Intent>? = null

    // Continuation run once the OS runtime-permission dialog resolves.
    private var pendingPermissionAction: ((Boolean) -> Unit)? = null

    // Pending WebView getUserMedia (camera/mic) request awaiting the dialog.
    private var pendingMediaRequest: PermissionRequest? = null

    // Pending navigator.geolocation prompt awaiting the dialog.
    private var pendingGeo: Pair<String, GeolocationPermissions.Callback>? = null

    // In-flight <input type="file" capture> state.
    private var pendingFileChooserCallback: ValueCallback<Array<Uri>>? = null
    private var pendingFileChooserParams: WebChromeClient.FileChooserParams? = null
    private var pendingCaptureUri: Uri? = null

    // ── Cached WebView overlay tracking (a single overlay at a time) ─────────
    // Lets close / hardware-back know where to land: RESPECT-launched lessons
    // hand the user back to the launcher; normally-opened forms just reveal the
    // Tangerine page underneath (the form list they were opened from).
    private var currentWebViewRoot: ViewGroup? = null
    private var currentWebView: WebView? = null
    private var currentRespectLaunch: Boolean = false
    private var currentIpcPackage: String? = null
    private var cachedWebViewBackCallback: OnBackPressedCallback? = null

    // ── Overlay loading state ────────────────────────────────────────────────
    // The overlay's WebView paints its default white background until the form
    // document AND its Angular bundles have loaded, which on a slow or
    // unreachable host looks exactly like a hang. A spinner panel covers that
    // window (see buildOverlayLoadingView / scheduleOverlayLoading).
    private var currentLoadingView: View? = null
    private var overlayContentFrame: FrameLayout? = null
    private var pendingLoadingShow: Runnable? = null
    private var overlayPageLoading: Boolean = false

    private val okHttpClient: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .addInterceptor(CacheInterceptor())
            .connectTimeout(30, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .followRedirects(true)
            .followSslRedirects(true)
            .build()
    }

    // OkHttp chain used by RESPECT-launched lesson WebViews: the launcher's IPC
    // cache is consulted FIRST (only-if-cached); misses fall through to the
    // network-first TangyCache interceptor below (order matters: the first
    // interceptor added runs first).
    private val respectOkHttpClient: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .addInterceptor(RespectIpcCacheInterceptor())
            .addInterceptor(CacheInterceptor())
            .connectTimeout(30, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .followRedirects(true)
            .followSslRedirects(true)
            .build()
    }

    // HttpIpcClient bound to the RESPECT launcher (built lazily, one per session).
    private var ipcHttpClient: HttpIpcClient? = null
    private var ipcHttpClientPackage: String? = null

    // The RESPECT launcher package. When this app is opened DIRECTLY (not
    // launched by the launcher) we still treat the launcher's HTTP-over-IPC
    // cache as an extra offline source, adopting whatever it serves into our
    // own cache so we become self-sufficient.
    private val DEFAULT_RESPECT_PACKAGE = "world.respect.app"

    private fun cacheDir(): File {
        val dir = File(activity?.cacheDir, "tangy-cache")
        if (!dir.exists()) dir.mkdirs()
        return dir
    }

    private fun metaDir(): File {
        val dir = File(activity?.filesDir, "tangy-cache-meta")
        if (!dir.exists()) dir.mkdirs()
        return dir
    }

    private fun pendingDir(): File {
        val dir = File(activity?.filesDir, "tangy-pending")
        if (!dir.exists()) dir.mkdirs()
        return dir
    }

    // Directory of xAPI statement batches still waiting for the RESPECT launcher.
    // Owned by XapiDelivery, which also schedules the WorkManager delivery job.
    private fun xapiPendingDir(): File = XapiDelivery.pendingDir(contextForWork())

    /**
     * A Context that outlives the Activity: the xAPI delivery queue is drained by
     * WorkManager, which may run when no Activity exists at all.
     */
    private fun contextForWork(): Context = activity?.applicationContext ?: context.applicationContext

    private fun parseHeaderMap(headersJson: String): Map<String, String> {
        if (headersJson.isBlank()) return emptyMap()
        return try {
            gson.fromJson(headersJson, object : TypeToken<Map<String, String>>() {}.type)
                ?: emptyMap()
        } catch (e: Exception) {
            emptyMap()
        }
    }

    private fun urlToFilename(url: String): String {
        // The URL fragment is client-side only and is never sent to the server,
        // so requests that differ only by "#fragment" (e.g. a pinned form URL vs
        // the lesson WebView's "…/#/form/<id>" document URL) MUST map to the SAME
        // cache entry. Otherwise a pinned form can't be served offline when the
        // WebView opens it (which always navigates with the fragment).
        val normalizedUrl = url.substringBefore('#')
        val hash = normalizedUrl.toByteArray(Charsets.UTF_8).let {
            val md = MessageDigest.getInstance("SHA-256")
            md.digest(it).joinToString("") { "%02x".format(it) }
        }
        return hash
    }

    private fun storeBytesOnDisk(url: String, mimeType: String, bytes: ByteArray, headers: Map<String, String>?) {
        val filename = urlToFilename(url)
        File(cacheDir(), filename).writeBytes(bytes)
        val meta = CacheMeta(
            url = url, mimeType = mimeType,
            headers = headers ?: emptyMap(),
            storedAt = System.currentTimeMillis(),
            sizeBytes = bytes.size.toLong()
        )
        File(metaDir(), "$filename.json").writeText(gson.toJson(meta), Charsets.UTF_8)
    }

    // Text convenience retained for the JS-facing store()/retrieve() API. The
    // OkHttp cache paths (CacheInterceptor / IPC adoption) store raw bytes so
    // binary resources (images, audio, video) are never corrupted.
    private fun storeOnDisk(url: String, mimeType: String, body: String, headers: Map<String, String>?) {
        storeBytesOnDisk(url, mimeType, body.toByteArray(Charsets.UTF_8), headers)
    }

    private fun retrieveBytesFromDisk(url: String): Pair<ByteArray, CacheMeta>? {
        val filename = urlToFilename(url)
        val file = File(cacheDir(), filename)
        val metaFile = File(metaDir(), "$filename.json")
        if (!file.exists()) return null
        val bytes = file.readBytes()
        val meta = if (metaFile.exists()) {
            gson.fromJson(metaFile.readText(Charsets.UTF_8), CacheMeta::class.java)
        } else {
            CacheMeta(url, "application/octet-stream", emptyMap(), 0L, 0L)
        }
        return Pair(bytes, meta)
    }

    private fun retrieveFromDisk(url: String): Pair<String, CacheMeta>? {
        return retrieveBytesFromDisk(url)?.let { (bytes, meta) ->
            Pair(String(bytes, Charsets.UTF_8), meta)
        }
    }

    // ── Cache validation helpers (ETag / Last-Modified / Cache-Control) ──

    /** Read just the metadata sidecar (headers, storedAt, size) — no body I/O. */
    private fun readMeta(url: String): CacheMeta? {
        val metaFile = File(metaDir(), "${urlToFilename(url)}.json")
        if (!metaFile.exists()) return null
        return try {
            gson.fromJson(metaFile.readText(Charsets.UTF_8), CacheMeta::class.java)
        } catch (e: Exception) {
            Log.w(TAG, "readMeta failed for $url: ${e.message}")
            null
        }
    }

    /** Header lookup is case-insensitive: OkHttp preserves the origin casing. */
    private fun metaHeader(meta: CacheMeta, name: String): String? =
        meta.headers.entries
            .firstOrNull { it.key.equals(name, ignoreCase = true) }
            ?.value

    /**
     * Freshness lifetime from `Cache-Control: max-age`, in ms.
     *
     * Null when the response carries no max-age, or explicitly forbids reuse
     * (`no-store` / `no-cache`). Those must always go back to the server.
     */
    private fun maxAgeMillis(meta: CacheMeta): Long? {
        val cc = metaHeader(meta, "Cache-Control") ?: return null
        if (cc.contains("no-store", ignoreCase = true) ||
            cc.contains("no-cache", ignoreCase = true)
        ) return null
        val match = Regex("(?:^|,)\\s*max-age\\s*=\\s*(\\d+)", RegexOption.IGNORE_CASE)
            .find(cc) ?: return null
        return match.groupValues[1].toLongOrNull()?.times(1000)
    }

    private fun isNoStore(meta: CacheMeta): Boolean =
        metaHeader(meta, "Cache-Control")?.contains("no-store", ignoreCase = true) == true

    /**
     * Build a 200 response from a stored copy. Bodies are returned untouched;
     * Content-Length/Content-Encoding are dropped because OkHttp may have
     * transparently decompressed the bytes we saved, so the origin's values can
     * disagree with what we are about to hand back.
     */
    private fun cachedResponse(
        request: Request,
        bytes: ByteArray,
        meta: CacheMeta,
        cacheState: String,
    ): Response {
        val rebuilt = Response.Builder()
            .request(request)
            .protocol(okhttp3.Protocol.HTTP_1_1)
            .code(200)
            .message("OK (cache)")
            .header("X-Cache", cacheState)
        meta.headers.forEach { (name, value) ->
            if (name.equals("Content-Length", true) ||
                name.equals("Content-Encoding", true) ||
                name.equals("Transfer-Encoding", true)
            ) return@forEach
            rebuilt.header(name, value)
        }
        rebuilt.body(bytes.toResponseBody(meta.mimeType.toMediaType()))
        return rebuilt.build()
    }

    /**
     * A 304 means the stored copy is still current: merge the validator/cache
     * headers the server just sent (they may have refreshed Cache-Control, Age
     * or ETag) and restart the max-age clock, so the next request inside the
     * window needs no network at all.
     */
    private fun touchMeta(url: String, meta: CacheMeta, response: Response): CacheMeta {
        val merged = meta.headers.toMutableMap()
        response.headers.names().forEach { name ->
            response.headers[name]?.let { merged[name] = it }
        }
        val updated = meta.copy(headers = merged, storedAt = System.currentTimeMillis())
        try {
            File(metaDir(), "${urlToFilename(url)}.json")
                .writeText(gson.toJson(updated), Charsets.UTF_8)
        } catch (e: Exception) {
            Log.w(TAG, "touchMeta failed for $url: ${e.message}")
        }
        return updated
    }

    // True when the device currently has an active network (any type). Used to
    // skip the network attempt when fully offline (airplane mode / radios off),
    // which avoids DNS/connect stalls that otherwise delay cached content for
    // seconds-to-tens-of-seconds. Deliberately does NOT check
    // NET_CAPABILITY_INTERNET, so a LAN-only server (no internet validation)
    // still counts as "online" and API/data fetches stay fresh.
    private fun hasActiveNetwork(): Boolean {
        val cm = activity?.getSystemService(Context.CONNECTIVITY_SERVICE)
            as? ConnectivityManager ?: return true
        return cm.activeNetwork != null
    }

    // Offline path: serve the URL from our disk cache; if we don't have it,
    // ask the RESPECT launcher's cache over IPC (adopting whatever it serves
    // into our own cache). Returns null when neither can help.
    private fun serveFromDiskOrRespect(request: Request): Response? {
        val url = request.url.toString()
        val fallback = retrieveBytesFromDisk(url)
        if (fallback != null) {
            val (body, meta) = fallback
            Log.d(TAG, "CacheInterceptor OFFLINE_FALLBACK $url")
            return Response.Builder()
                .request(request)
                .protocol(okhttp3.Protocol.HTTP_1_1)
                .code(200)
                .message("OK (offline)")
                .header("Content-Type", meta.mimeType)
                .header("X-Cache", "OFFLINE_FALLBACK")
                .body(body.toResponseBody(meta.mimeType.toMediaType()))
                .build()
        }
        // Direct (non-launcher) offline opens: if our own cache lacks the
        // resource, ask the RESPECT launcher's cache over IPC and adopt
        // whatever it can serve into our own cache.
        return tryRespectCacheOfflineFallback(request)
    }

    // Fire-and-forget network refresh of a cached resource, used when the WebView
    // serves a pinned copy instantly (cache-first). While ONLINE this keeps the
    // pinned copy current for the NEXT open (the network-first CacheInterceptor
    // stores the fresh bytes on success), preserving the auto-refresh behaviour a
    // network-first open used to give. Offline (or server unreachable) the
    // attempt fails harmlessly in the background and the served copy is used.
    private fun refreshCachedResourceInBackground(url: String) {
        if (backgroundRefreshInFlight.putIfAbsent(url, true) != null) return
        scope.launch {
            try {
                val okRequest = Request.Builder().url(url).get().build()
                val client = if (currentIpcPackage.isNullOrBlank()) okHttpClient else respectOkHttpClient
                val response = client.newCall(okRequest).execute()
                response.close()
            } catch (e: Exception) {
                Log.w(TAG, "Background cache refresh failed for $url: ${e.message}")
            } finally {
                backgroundRefreshInFlight.remove(url)
            }
        }
    }

    inner class CacheInterceptor : Interceptor {
        override fun intercept(chain: Interceptor.Chain): Response {
            val request = chain.request()
            val url = request.url.toString()

            // Only GET requests are cached. POST/PUT/DELETE (login, form
            // submissions, mutations) must always hit the network and must
            // never read from or write to the GET cache.
            if (request.method != "GET") {
                return chain.proceed(request)
            }

            // A "force" request (sync button / explicit refresh) must reach the
            // server even if our copy is still inside its max-age window. A
            // "probe" request wants the current bytes for comparison but must
            // NOT replace the cached copy — a staleness check must never mutate
            // what it is measuring. Both markers are stripped here so they
            // never reach the origin.
            val forceRefresh = request.header(HEADER_FORCE_REFRESH) != null
            val noStoreProbe = request.header(HEADER_NO_STORE) != null
            val cleanRequest = if (forceRefresh || noStoreProbe) {
                request.newBuilder()
                    .removeHeader(HEADER_FORCE_REFRESH)
                    .removeHeader(HEADER_NO_STORE)
                    .build()
            } else {
                request
            }

            // Truly offline (no active network at all — airplane mode / radios
            // off): don't attempt a connection. Serving straight from disk
            // avoids the DNS/connect stalls that make the FIRST offline load of
            // a cached page take 20-30s (or hang) before falling back to cache.
            if (!hasActiveNetwork()) {
                Log.d(TAG, "CacheInterceptor OFFLINE_FASTPATH $url — no active network")
                serveFromDiskOrRespect(cleanRequest)?.let { return it }
                throw IOException("Offline (no active network) and not cached: $url")
            }

            // Note: a forced request still uses the stored validators below. It
            // only skips the freshness shortcut — so "check now" costs a
            // conditional GET (usually 304), not a full body download.
            val meta = readMeta(url)

            // 1. Still fresh per the server's Cache-Control: max-age — no
            //    request at all. This is where the Tangerine catalogs (10s) and
            //    per-form publication descriptors (300s) actually save traffic.
            if (!forceRefresh && !noStoreProbe && meta != null && !isNoStore(meta)) {
                val maxAge = maxAgeMillis(meta)
                val age = System.currentTimeMillis() - meta.storedAt
                if (maxAge != null && age in 0 until maxAge) {
                    retrieveBytesFromDisk(url)?.let { (bytes, stored) ->
                        Log.d(TAG, "CacheInterceptor FRESH_HIT $url (age ${age}ms < ${maxAge}ms)")
                        return cachedResponse(cleanRequest, bytes, stored, "FRESH_HIT")
                    }
                }
            }

            // 2. Stale (or forced): revalidate with the validators the server
            //    gave us instead of downloading the body again. A 304 then costs
            //    headers only — this is the RESPECT-style check the Tangerine
            //    server supports (ETag + Last-Modified on every OPDS response).
            val etag = meta?.let { metaHeader(it, "etag") }
            val lastModified = meta?.let { metaHeader(it, "last-modified") }
            val canValidate = meta != null && !isNoStore(meta) &&
                (etag != null || lastModified != null)
            val networkRequest = if (canValidate) {
                cleanRequest.newBuilder().apply {
                    etag?.also { header("If-None-Match", it) }
                    lastModified?.also { header("If-Modified-Since", it) }
                }.build()
            } else {
                cleanRequest
            }

            Log.d(
                TAG,
                "CacheInterceptor FETCH $url — trying network" +
                    (if (canValidate) " (conditional)" else "")
            )
            return try {
                val networkResponse = chain.proceed(networkRequest)

                if (networkResponse.code == 304 && meta != null) {
                    // Still current: refresh storedAt + cache headers, serve the
                    // copy we already have. The body was never transferred. A
                    // probe leaves the metadata untouched.
                    val updatedMeta = if (noStoreProbe) meta else touchMeta(url, meta, networkResponse)
                    networkResponse.close()
                    val stored = retrieveBytesFromDisk(url)
                    if (stored != null) {
                        Log.d(TAG, "CacheInterceptor REVALIDATED $url (304)")
                        cachedResponse(cleanRequest, stored.first, updatedMeta, "REVALIDATED")
                    } else {
                        Log.w(TAG, "CacheInterceptor 304 but body missing for $url — refetching")
                        chain.proceed(cleanRequest)
                    }
                } else if (noStoreProbe) {
                    // Caller only wants the bytes for comparison: hand them back
                    // without touching the cached entry.
                    Log.d(TAG, "CacheInterceptor PROBE $url (not stored)")
                    networkResponse
                } else if (networkResponse.isSuccessful && networkResponse.body != null) {
                    try {
                        val bodyBytes = networkResponse.body!!.bytes()
                        val contentType = networkResponse.header("Content-Type")
                            ?: "application/octet-stream"
                        val headers = mutableMapOf<String, String>()
                        networkResponse.headers.names().forEach { name ->
                            networkResponse.headers[name]?.let { headers[name] = it }
                        }
                        storeBytesOnDisk(url, contentType, bodyBytes, headers)
                        Log.d(TAG, "CacheInterceptor STORED $url")

                        val rebuilt = Response.Builder()
                            .request(cleanRequest)
                            .protocol(networkResponse.protocol)
                            .code(networkResponse.code)
                            .message(networkResponse.message)
                            .header("X-Cache", "MISS")
                        networkResponse.headers.names().forEach { name ->
                            networkResponse.headers[name]?.let { rebuilt.header(name, it) }
                        }
                        rebuilt.body(bodyBytes.toResponseBody(contentType.toMediaType()))
                        networkResponse.close()
                        rebuilt.build()
                    } catch (e: Exception) {
                        Log.w(TAG, "CacheInterceptor store failed $url: ${e.message}")
                        networkResponse
                    }
                } else {
                    networkResponse
                }
            } catch (e: Exception) {
                // Network failed — try cache as fallback for offline resilience
                Log.w(TAG, "CacheInterceptor network failed for $url: ${e.message} — trying cache fallback")
                serveFromDiskOrRespect(cleanRequest) ?: throw e
            }
        }
    }

    /**
     * OkHttp interceptor used ONLY for RESPECT-launched lessons. It asks the
     * RESPECT launcher (via HTTP-over-IPC, `Cache-Control: only-if-cached`) for
     * the resource first so content the launcher downloaded plays OFFLINE from
     * RESPECT's own cache. When the launcher cannot satisfy the request (cache
     * miss / service not reachable) we fall through to the normal network-first
     * TangyCache interceptor, so direct (non-RESPECT) use is unchanged.
     */
    inner class RespectIpcCacheInterceptor : Interceptor {
        override fun intercept(chain: Interceptor.Chain): Response {
            val request = chain.request()
            val pkg = currentIpcPackage
            if (pkg.isNullOrBlank()) {
                return chain.proceed(request)
            }
            val client = ensureIpcClient(pkg) ?: return chain.proceed(request)
            return try {
                val ipcRequest = request.newBuilder()
                    .header("Cache-Control", "only-if-cached")
                    .build()
                val ipcResponse = client.newCall(ipcRequest).execute()
                if (ipcResponse.isSuccessful) {
                    Log.d(TAG, "RespectIpcCache HIT ${request.url} via $pkg")
                    // Adopt the launcher-served bytes into our OWN cache so the
                    // resource is available offline even without the launcher.
                    val url = request.url.toString()
                    val bodyBytes = ipcResponse.body?.bytes() ?: ByteArray(0)
                    val contentType = ipcResponse.header("Content-Type") ?: "application/octet-stream"
                    val headers = mutableMapOf<String, String>()
                    ipcResponse.headers.names().forEach { name ->
                        ipcResponse.headers[name]?.let { headers[name] = it }
                    }
                    storeBytesOnDisk(url, contentType, bodyBytes, headers)
                    val rebuilt = Response.Builder()
                        .request(request)
                        .protocol(ipcResponse.protocol)
                        .code(ipcResponse.code)
                        .message(ipcResponse.message)
                        .header("X-Cache", "RESPECT_IPC_HIT")
                    ipcResponse.headers.names().forEach { name ->
                        ipcResponse.headers[name]?.let { rebuilt.header(name, it) }
                    }
                    rebuilt.body(bodyBytes.toResponseBody(contentType.toMediaType()))
                    ipcResponse.close()
                    rebuilt.build()
                } else {
                    Log.d(TAG, "RespectIpcCache MISS ${request.url} (${ipcResponse.code}) - falling back")
                    ipcResponse.close()
                    chain.proceed(request)
                }
            } catch (e: Throwable) {
                Log.w(TAG, "RespectIpcCache error for ${request.url}: ${e.message} - falling back to own cache/network")
                chain.proceed(request)
            }
        }
    }

    @Synchronized
    private fun ensureIpcClient(pkg: String): HttpIpcClient? {
        ipcHttpClient?.let { existing ->
            if (ipcHttpClientPackage == pkg) return existing
            try {
                existing.close()
            } catch (_: Exception) {
            }
            ipcHttpClient = null
            ipcHttpClientPackage = null
        }
        val act = activity ?: return null
        return try {
            // Only bind when the launcher actually exposes the HTTP-over-IPC service
            // so we never stall a page load on an unresolvable package.
            val probe = Intent("org.openeel.action.httpoveripc.connect").setPackage(pkg)
            if (act.packageManager.queryIntentServices(probe, 0).isEmpty()) {
                Log.w(TAG, "RespectIpcCache: no http-over-ipc service for $pkg - using own cache only")
                return null
            }
            HttpIpcClientBuilder(act)
                .setIpcServicePackageName(pkg)
                .build()
                .also {
                    ipcHttpClient = it
                    ipcHttpClientPackage = pkg
                    Log.d(TAG, "RespectIpcCache: bound HttpIpcClient to $pkg")
                }
        } catch (e: Exception) {
            Log.w(TAG, "RespectIpcCache: could not create HttpIpcClient for $pkg: ${e.message}")
            null
        }
    }

    private fun closeIpcClient() {
        ipcHttpClient?.let {
            try {
                it.close()
            } catch (_: Exception) {
            }
        }
        ipcHttpClient = null
        ipcHttpClientPackage = null
    }

    /**
     * Used by the direct (non-launcher) offline path. When the network is down
     * and our own cache has no copy, ask the RESPECT launcher's HTTP-over-IPC
     * cache (`only-if-cached`) for the resource. If the launcher has it we serve
     * it AND adopt it into our own disk cache, so the resource becomes locally
     * available (and the UI checkmark becomes truthful) even if the launcher is
     * later unavailable. Returns null when the launcher can't help.
     */
    private fun tryRespectCacheOfflineFallback(request: Request): Response? {
        // Launched by RESPECT? The upstream RespectIpcCacheInterceptor already
        // asked the launcher, so don't ask again here.
        if (!currentIpcPackage.isNullOrBlank()) return null
        val act = activity ?: return null
        // Only bind when the launcher is actually installed and exposes the
        // service so we never stall a page load on an unresolvable package.
        val probe = Intent("org.openeel.action.httpoveripc.connect").setPackage(DEFAULT_RESPECT_PACKAGE)
        if (act.packageManager.queryIntentServices(probe, 0).isEmpty()) {
            return null
        }
        val client = ensureIpcClient(DEFAULT_RESPECT_PACKAGE) ?: return null
        return try {
            val ipcRequest = request.newBuilder()
                .header("Cache-Control", "only-if-cached")
                .build()
            val ipcResponse = client.newCall(ipcRequest).execute()
            if (ipcResponse.isSuccessful && ipcResponse.body != null) {
                val url = request.url.toString()
                val bodyBytes = ipcResponse.body!!.bytes()
                val contentType = ipcResponse.header("Content-Type") ?: "application/octet-stream"
                val headers = mutableMapOf<String, String>()
                ipcResponse.headers.names().forEach { name ->
                    ipcResponse.headers[name]?.let { headers[name] = it }
                }
                storeBytesOnDisk(url, contentType, bodyBytes, headers)
                Log.d(TAG, "RespectIpcCache OFFLINE_ADOPT $url via $DEFAULT_RESPECT_PACKAGE")
                val rebuilt = Response.Builder()
                    .request(request)
                    .protocol(okhttp3.Protocol.HTTP_1_1)
                    .code(200)
                    .message("OK (respect-ipc)")
                    .header("X-Cache", "RESPECT_IPC_ADOPT")
                ipcResponse.headers.names().forEach { name ->
                    ipcResponse.headers[name]?.let { rebuilt.header(name, it) }
                }
                rebuilt.body(bodyBytes.toResponseBody(contentType.toMediaType()))
                ipcResponse.close()
                rebuilt.build()
            } else {
                ipcResponse.close()
                null
            }
        } catch (e: Throwable) {
            Log.w(TAG, "RespectIpcCache offline fallback failed for ${request.url}: ${e.message}")
            null
        }
    }

    inner class CachingWebViewClient : WebViewClient() {
        override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
            super.onPageStarted(view, url, favicon)
            if (view != null) scheduleOverlayLoading(view)
        }

        override fun onPageFinished(view: WebView?, url: String?) {
            super.onPageFinished(view, url)
            // Identity check: a superseded overlay's WebView can still report
            // finish, and must not clear the bar of the overlay now on screen.
            if (view != null && view === currentWebView) hideOverlayLoading()
            // Inject the form interceptor (offline submissions) plus the
            // permission-help banner (camera/mic/location denial messaging)
            // and the xAPI relay (RESPECT launcher IPC handoff).
            view?.evaluateJavascript(FORM_INTERCEPT_SCRIPT, null)
            // Paint the player with the app's Tangerine palette (the release
            // ships Material's default indigo/pink chrome).
            view?.evaluateJavascript(FORM_THEME_SCRIPT, null)
            view?.evaluateJavascript(PERMISSION_HELP_SCRIPT, null)
            view?.evaluateJavascript(XAPI_RELAY_SCRIPT, null)
            // Move xAPI batches the form player parked in its own localStorage outbox
            // into the native delivery queue (disk + WorkManager).
            view?.evaluateJavascript(XAPI_OUTBOX_MIRROR_SCRIPT, null)
            view?.evaluateJavascript(XHR_QUEUE_SCRIPT, null)
            // Auto-close after submission (returns to the Tangerine form list for
            // forms opened from it; RESPECT-launched lessons are handled natively).
            view?.evaluateJavascript(FORM_SUBMIT_WATCH_SCRIPT, null)
        }

        /**
         * A failed main-frame load used to leave the overlay white forever. Show
         * what happened, with a retry and a way back.
         */
        override fun onReceivedError(
            view: WebView?,
            request: WebResourceRequest?,
            error: WebResourceError?
        ) {
            super.onReceivedError(view, request, error)
            if (view == null || request == null || !request.isForMainFrame) return
            val description = error?.description?.toString()
                ?.takeIf { it.isNotBlank() }
                ?: "The form could not be loaded."
            Log.w(TAG, "Overlay load failed: $description (${request.url})")
            showOverlayError(view, description)
        }

        override fun shouldInterceptRequest(
            view: WebView?,
            request: WebResourceRequest?
        ): WebResourceResponse? {
            if (request == null || request.method.uppercase() != "GET") return null
            val reqUrl = request.url.toString()
            try {
                // Cache-first for resources we already hold on disk (pinned form
                // assets, previously-seen CSS/JS/fonts). Waiting on the network
                // first — as the CacheInterceptor does for freshness — makes an
                // offline/DNS-unreachable host stall for its full connect/DNS
                // timeout before the cache fallback runs. When that resource is
                // render-blocking (form HTML, CSS incl. Google Fonts, JS) the
                // WHOLE first load appears stuck for 20-30s (or forever); the
                // second open only feels instant because the OS has since
                // negative-cached the failed DNS/connection and fails fast.
                // Serving the pinned copy immediately makes cached forms open
                // instantly in ANY connectivity state. Resources we do NOT have
                // are fetched network-first below (fresh download + stored), so
                // first-time online opens of unpinned forms are unchanged.
                val cached = retrieveBytesFromDisk(reqUrl)
                if (cached != null) {
                    val (body, meta) = cached
                    Log.d(TAG, "CachingWebViewClient CACHE_HIT $reqUrl")
                    val mimeType = meta.mimeType.substringBefore(";")
                    val encoding = meta.mimeType.substringAfter("charset=", "")
                        .ifEmpty { null }
                    val respHeaders = mutableMapOf("X-Cache" to "CACHE_HIT")
                    // Skip length/encoding headers: OkHttp may have transparently
                    // decompressed the stored body, so the original values can
                    // mismatch the bytes we serve. WebView derives length itself.
                    meta.headers.forEach { (k, v) ->
                        if (k.equals("Content-Length", true) ||
                            k.equals("Content-Encoding", true) ||
                            k.equals("Transfer-Encoding", true)) return@forEach
                        respHeaders[k] = v
                    }
                    // While online, opportunistically refresh this resource in the
                    // background (deduped) so the pinned copy stays current for
                    // future opens — rendering is NOT blocked on it. When offline
                    // or the server is unreachable the attempt fails harmlessly.
                    if (hasActiveNetwork()) {
                        refreshCachedResourceInBackground(reqUrl)
                    }
                    return WebResourceResponse(
                        mimeType, encoding, 200, "OK",
                        respHeaders, body.inputStream()
                    )
                }

                val okRequest = Request.Builder().url(reqUrl).apply {
                    request.requestHeaders.entries.forEach {
                        header(it.key, it.value)
                    }
                }.build()

                // RESPECT-launched lessons ask the launcher's IPC cache first
                // (respectOkHttpClient); everything else uses the plain TangyCache
                // network-first client.
                val client = if (currentIpcPackage.isNullOrBlank()) okHttpClient else respectOkHttpClient
                val response = client.newCall(okRequest).execute()
                val contentType = response.header("Content-Type") ?: "application/octet-stream"
                val mimeType = contentType.substringBefore(";")
                val encoding = contentType.substringAfter("charset=", "").ifEmpty { null }
                val bodyBytes = response.body?.bytes() ?: ByteArray(0)
                response.close()

                val respHeaders = mutableMapOf<String, String>()
                response.headers.names().forEach { name ->
                    response.headers[name]?.let { respHeaders[name] = it }
                }

                return WebResourceResponse(
                    mimeType, encoding, response.code,
                    response.message, respHeaders,
                    bodyBytes.inputStream()
                )
            } catch (e: Exception) {
                Log.w(TAG, "WebViewClient intercept failed for $reqUrl: ${e.message}")
                return null
            }
        }
    }

    /**
     * WebChromeClient for cached survey WebViews. Tangerine field types
     * (photo / audio / video / location) use standard browser APIs -
     * getUserMedia, navigator.geolocation and <input type=file capture> -
     * which the stock WebChromeClient does not surface. This bridges them to
     * Android runtime permission requests and the OS camera / gallery apps.
     */
    inner class CachedFormsWebChromeClient : WebChromeClient() {

        /**
         * Forward console messages from the lesson WebView (e.g. the form player's
         * "[xAPI Debug]" logs and the injected XAPI_RELAY_SCRIPT logs) into logcat so the
         * RESPECT xAPI relay path can be diagnosed.
         */
        override fun onConsoleMessage(message: ConsoleMessage?): Boolean {
            if (message != null && !message.message().isNullOrBlank()) {
                Log.i(TAG, "LessonJS[" + (message.messageLevel()?.name ?: "LOG") + "]: " + message.message())
            }
            return super.onConsoleMessage(message)
        }

        /** Real load progress for the overlay (0..100, main-frame weighted). */
        override fun onProgressChanged(view: WebView?, newProgress: Int) {
            super.onProgressChanged(view, newProgress)
            // Nothing to draw: the loader is indeterminate. But a page that reaches
            // 100% has finished rendering its main frame, so stop covering it.
            if (newProgress >= 100 && view != null && view === currentWebView) {
                hideOverlayLoading()
            }
        }

        override fun onPermissionRequest(request: PermissionRequest) {
            val wanted = request.resources.toSet()
            val needsCamera = wanted.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)
            val needsMic = wanted.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)

            val perms = mutableListOf<String>()
            if (needsCamera) perms.add(Manifest.permission.CAMERA)
            if (needsMic) {
                perms.add(Manifest.permission.RECORD_AUDIO)
                perms.add(Manifest.permission.MODIFY_AUDIO_SETTINGS)
            }

            // Unrelated resource types (MIDI, protected media, ...) never need a prompt.
            if (perms.isEmpty()) {
                request.grant(request.resources)
                return
            }
            if (hasPermissions(perms)) {
                request.grant(request.resources)
                return
            }

            pendingMediaRequest = request
            pendingPermissionAction = { granted ->
                val pending = pendingMediaRequest
                pendingMediaRequest = null
                if (pending != null) {
                    if (granted) {
                        pending.grant(pending.resources)
                    } else {
                        pending.deny()
                        showPermissionMessage(
                            "Camera or microphone permission was denied. To answer this " +
                                "question, allow it in Settings."
                        )
                    }
                }
            }
            requestRuntimePermissions(perms.toTypedArray())
        }

        override fun onGeolocationPermissionsShowPrompt(
            origin: String,
            callback: GeolocationPermissions.Callback
        ) {
            val perms = arrayOf(
                Manifest.permission.ACCESS_COARSE_LOCATION,
                Manifest.permission.ACCESS_FINE_LOCATION
            )
            if (hasPermissions(perms.toList())) {
                callback.invoke(origin, true, false)
                return
            }

            pendingGeo = origin to callback
            pendingPermissionAction = { granted ->
                val geo = pendingGeo
                pendingGeo = null
                if (geo != null) {
                    when {
                        granted -> geo.second.invoke(geo.first, true, false)
                        // Android 12+ allows granting approximate (coarse) only.
                        Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
                            hasPermissions(listOf(Manifest.permission.ACCESS_COARSE_LOCATION)) ->
                            geo.second.invoke(geo.first, true, false)
                        else -> {
                            geo.second.invoke(geo.first, false, false)
                            showPermissionMessage(
                                "Location permission was denied. To answer this " +
                                    "question, allow it in Settings."
                            )
                        }
                    }
                }
            }
            requestRuntimePermissions(perms)
        }

        override fun onShowFileChooser(
            webView: WebView,
            filePathCallback: ValueCallback<Array<Uri>>,
            fileChooserParams: FileChooserParams
        ): Boolean {
            pendingFileChooserCallback = filePathCallback
            pendingFileChooserParams = fileChooserParams
            openFileChooser(fileChooserParams)
            return true
        }
    }

    // ── Permission helpers (Android runtime permissions + messages) ───────

    private fun hasPermissions(perms: Collection<String>): Boolean {
        val ctx = activity ?: return false
        return perms.all {
            ContextCompat.checkSelfPermission(ctx, it) == PackageManager.PERMISSION_GRANTED
        }
    }

    private fun permissionRationale(perms: Array<String>): String {
        val hasCam = perms.contains(Manifest.permission.CAMERA)
        val hasMic = perms.contains(Manifest.permission.RECORD_AUDIO)
        val hasLoc = perms.contains(Manifest.permission.ACCESS_FINE_LOCATION) ||
            perms.contains(Manifest.permission.ACCESS_COARSE_LOCATION)
        return when {
            hasCam && hasMic ->
                "This question needs your camera and microphone. Tap Allow to record."
            hasCam ->
                "This question needs your camera. Tap Allow to take a photo or video."
            hasMic ->
                "This question needs your microphone. Tap Allow to record audio."
            hasLoc ->
                "This question needs your location. Tap Allow so it can be captured."
            else -> "This question needs a device permission. Tap Allow to continue."
        }
    }

    private fun requestRuntimePermissions(perms: Array<String>) {
        val launcher = permissionLauncher
        if (launcher == null || activity == null) {
            val action = pendingPermissionAction
            pendingPermissionAction = null
            action?.invoke(false)
            return
        }
        // Show a short explanation BEFORE the OS dialog so users understand why
        // the survey is asking (Android's own dialog text cannot be customized).
        showPermissionMessage(permissionRationale(perms))
        launcher.launch(perms)
    }

    private fun showPermissionMessage(message: String) {
        val act = activity ?: return
        Toast.makeText(act, message, Toast.LENGTH_LONG).show()
    }

    // ── File chooser helpers (<input type=file capture>) ─────────────────

    private fun openFileChooser(params: WebChromeClient.FileChooserParams) {
        val acceptTypes = params.acceptTypes?.toList() ?: emptyList()
        val capture = params.isCaptureEnabled
        val capturePhoto = capture && acceptTypes.contains("image/*")
        val captureVideo = capture && acceptTypes.contains("video/*")

        when {
            capturePhoto || captureVideo -> {
                if (hasPermissions(listOf(Manifest.permission.CAMERA))) {
                    if (!launchCapture(captureVideo)) launchDocumentPicker(params)
                } else {
                    pendingPermissionAction = { granted ->
                        if (granted) {
                            if (!launchCapture(captureVideo)) launchDocumentPicker(params)
                        } else {
                            completeFileChooser(null)
                            showPermissionMessage(
                                "Camera permission was denied. To attach a photo, allow it in Settings."
                            )
                        }
                    }
                    requestRuntimePermissions(arrayOf(Manifest.permission.CAMERA))
                }
            }
            else -> launchDocumentPicker(params)
        }
    }

    /** Launch the OS camera app. Returns false if no camera app is installed. */
    @SuppressLint("QueryPermissionsNeeded")
    private fun launchCapture(isVideo: Boolean): Boolean {
        val act = activity ?: return false
        val intent = if (isVideo) {
            Intent(MediaStore.ACTION_VIDEO_CAPTURE)
        } else {
            Intent(MediaStore.ACTION_IMAGE_CAPTURE)
        }
        if (intent.resolveActivity(act.packageManager) == null) return false

        if (!isVideo) {
            val uri = createImageCaptureUri(act) ?: return false
            intent.putExtra(MediaStore.EXTRA_OUTPUT, uri)
            intent.addFlags(
                Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            )
            pendingCaptureUri = uri
        }
        fileChooserLauncher?.launch(intent)
        return true
    }

    private fun launchDocumentPicker(params: WebChromeClient.FileChooserParams) {
        val launcher = fileChooserLauncher
        if (launcher == null) {
            completeFileChooser(null)
            return
        }
        val intent = params.createIntent()
        if (params.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) {
            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        }
        val acceptTypes = params.acceptTypes?.filter { it.isNotBlank() } ?: emptyList()
        if (acceptTypes.isNotEmpty()) {
            intent.putExtra(Intent.EXTRA_MIME_TYPES, acceptTypes.toTypedArray())
        }
        launcher.launch(intent)
    }

    @SuppressLint("QueryPermissionsNeeded")
    private fun createImageCaptureUri(act: Activity): Uri? {
        return try {
            val dir = act.getExternalFilesDir(Environment.DIRECTORY_PICTURES) ?: act.filesDir
            if (!dir.exists()) dir.mkdirs()
            val name = "IMG_${SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())}.jpg"
            FileProvider.getUriForFile(act, "${act.packageName}.fileprovider", File(dir, name))
        } catch (e: Exception) {
            Log.e(TAG, "createImageCaptureUri failed", e)
            null
        }
    }

    /** Called when the OS camera / gallery activity finishes. */
    private fun resolveFileChooserResult(result: ActivityResult) {
        val callback = pendingFileChooserCallback
        pendingFileChooserCallback = null
        pendingFileChooserParams = null
        if (callback == null) return

        val captureUri = pendingCaptureUri
        pendingCaptureUri = null

        when {
            result.resultCode == Activity.RESULT_OK && captureUri != null ->
                callback.onReceiveValue(arrayOf(captureUri))
            result.resultCode == Activity.RESULT_OK ->
                callback.onReceiveValue(
                    WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
                )
            else -> callback.onReceiveValue(null)
        }
    }

    private fun completeFileChooser(uris: Array<Uri>?) {
        pendingFileChooserCallback?.onReceiveValue(uris)
        pendingFileChooserCallback = null
        pendingFileChooserParams = null
        pendingCaptureUri = null
    }

    /**
     * The DEMO MODE pill for the cached-WebView toolbar.
     *
     * The app's own header shows this pill on every screen (`.demo-badge` in
     * www/css/styles.css), because the demo server gives any visitor read/write
     * access to shared sample data. A form, however, opens in a separate WebView
     * with its own native toolbar — so the pill disappeared exactly where a user
     * is most likely to edit that shared data.
     *
     * Same look as the web pill: accent orange fill, dark navy text, uppercase,
     * pill radius. It is a label, not a control, so it never takes a tap.
     */
    private fun buildDemoModeBadge(act: Activity, label: String): TextView {
        val density = act.resources.displayMetrics.density
        fun dp(value: Int) = (value * density).toInt()
        val background = GradientDrawable().apply {
            setColor(Color.parseColor("#f26f10"))
            cornerRadius = dp(11).toFloat()
        }
        return TextView(act).apply {
            text = label
            setTextColor(Color.parseColor("#212a3f"))
            textSize = 11f
            typeface = Typeface.DEFAULT_BOLD
            letterSpacing = 0.06f
            isAllCaps = true
            gravity = Gravity.CENTER
            setPadding(dp(9), dp(3), dp(9), dp(3))
            setBackground(background)
            isClickable = false
            isFocusable = false
            contentDescription = label
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { gravity = Gravity.CENTER_VERTICAL }
        }
    }

    /**
     * Loading UI for the cached-WebView overlay: a white panel with a centred
     * spinner and a label, drawn on top of the WebView.
     *
     * A form is an Angular SPA: after the document arrives its bundles still have
     * to download, compile and bootstrap before anything paints, so the overlay
     * otherwise sits on the WebView's unstyled white page for a noticeable time
     * — indistinguishable from a hang on a slow or unreachable host. The form
     * cannot do this itself: it cannot render until that same work is done.
     */
    private fun buildOverlayLoadingView(act: Activity): LinearLayout {
        val density = act.resources.displayMetrics.density
        fun dp(value: Int) = (value * density).toInt()
        val box = LinearLayout(act).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            // Opaque: it is covering the page, not annotating it.
            setBackgroundColor(Color.WHITE)
            visibility = View.GONE
        }
        box.addView(ProgressBar(act).apply {
            isIndeterminate = true
            indeterminateTintList = ColorStateList.valueOf(Color.parseColor("#3c5b8d"))
        })
        box.addView(TextView(act).apply {
            text = "Loading form…"
            setTextColor(Color.parseColor("#3c5b8d"))
            textSize = 14f
            gravity = Gravity.CENTER
            setPadding(0, dp(12), 0, 0)
        })
        return box
    }

    /**
     * Reveal the loading panel if the load is still running after a short grace
     * period. Pinned/offline forms finish inside it, and a spinner that flashes
     * on every tap is worse than no spinner at all.
     */
    private fun scheduleOverlayLoading(webView: WebView) {
        if (webView !== currentWebView) return
        val loader = currentLoadingView ?: return
        cancelPendingLoadingShow()
        loader.visibility = View.GONE
        overlayPageLoading = true
        val show = Runnable {
            pendingLoadingShow = null
            if (webView === currentWebView && overlayPageLoading) {
                Log.d(TAG, "Overlay loader shown (load still running after grace)")
                loader.visibility = View.VISIBLE
            }
        }
        pendingLoadingShow = show
        loader.postDelayed(show, OVERLAY_LOADING_GRACE_MS)
    }

    private fun hideOverlayLoading() {
        overlayPageLoading = false
        cancelPendingLoadingShow()
        currentLoadingView?.visibility = View.GONE
    }

    private fun cancelPendingLoadingShow() {
        val pending = pendingLoadingShow ?: return
        currentLoadingView?.removeCallbacks(pending)
        pendingLoadingShow = null
    }

    /**
     * Replace a failed load with an explanation. Without this the overlay keeps
     * showing a blank white page with no hint that anything went wrong.
     */
    private fun showOverlayError(webView: WebView, description: String) {
        val act = activity ?: return
        val root = currentWebViewRoot ?: return
        val frame = overlayContentFrame ?: return
        if (webView !== currentWebView) return
        hideOverlayLoading()
        // A failed load can report several errors; keep the first explanation.
        if (frame.findViewWithTag<View>(OVERLAY_ERROR_TAG) != null) return

        val density = act.resources.displayMetrics.density
        fun dp(value: Int) = (value * density).toInt()

        webView.visibility = View.GONE
        val errorView = LinearLayout(act).apply {
            tag = OVERLAY_ERROR_TAG
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(Color.WHITE)
            setPadding(dp(32), dp(32), dp(32), dp(32))
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        }
        errorView.addView(TextView(act).apply {
            text = "Could not open this form"
            setTextColor(Color.parseColor("#212a3f"))
            textSize = 18f
            gravity = Gravity.CENTER
        })
        errorView.addView(TextView(act).apply {
            text = description
            setTextColor(Color.parseColor("#555555"))
            textSize = 13f
            gravity = Gravity.CENTER
            setPadding(0, dp(8), 0, dp(24))
        })
        val buttons = LinearLayout(act).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
        }
        buttons.addView(Button(act).apply {
            text = "Try again"
            setOnClickListener {
                frame.removeView(errorView)
                webView.visibility = View.VISIBLE
                webView.reload()
            }
        })
        buttons.addView(Button(act).apply {
            text = "Close"
            setOnClickListener { closeCachedWebView(root) }
        })
        errorView.addView(buttons)
        frame.addView(errorView)
    }

    /** Release any pending permission/file-chooser state, then remove the WebView. */
    private fun closeCachedWebView(rootLayout: ViewGroup) {
        completeFileChooser(null)
        hideOverlayLoading()
        currentLoadingView = null
        overlayContentFrame = null
        val media = pendingMediaRequest
        val action = pendingPermissionAction
        pendingMediaRequest = null
        pendingPermissionAction = null
        pendingGeo = null
        if (media != null) {
            try {
                media.deny()
            } catch (_: Exception) {
                // WebView may already be gone - ignore
            }
        }
        action?.invoke(false)
        (rootLayout.parent as? ViewGroup)?.removeView(rootLayout)

        // Capture + clear the per-overlay state before deciding where to land.
        val wasRespectLaunch = currentRespectLaunch
        val ipcPackage = currentIpcPackage
        currentWebViewRoot = null
        currentWebView = null
        currentRespectLaunch = false
        currentIpcPackage = null
        closeIpcClient()
        unregisterCachedWebViewBackHandler()

        // A RESPECT-launched lesson hands the user back to the launcher that
        // opened it (same behaviour as form completion). Any other form just
        // reveals the Tangerine page underneath — i.e. the form list it was
        // opened from.
        if (wasRespectLaunch) {
            finishAndReturnToLauncher(ipcPackage)
        }
    }

    /** Extract the RESPECT launcher package from a lesson URL, if present. */
    private fun urlRespectIpcPackage(url: String): String? {
        return try {
            Uri.parse(url).getQueryParameter("xapiIpcPackage")
        } catch (_: Exception) {
            null
        }
    }

    /**
     * Intercept the Android hardware/gesture back button while a cached WebView
     * overlay is open. Without this, back is handled by Capacitor and only
     * navigates the hidden shell underneath. While the overlay is open:
     *  - a lesson with its own history steps back through it first;
     *  - at the lesson root, back closes the overlay (returning to the RESPECT
     *    launcher for RESPECT-launched lessons, or to the Tangerine list otherwise).
     */
    private fun registerCachedWebViewBackHandler() {
        val act = activity ?: return
        if (cachedWebViewBackCallback != null) return
        val callback = object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val webView = currentWebView
                val root = currentWebViewRoot
                if (webView == null || root == null) return
                if (webView.canGoBack()) {
                    webView.goBack()
                } else {
                    closeCachedWebView(root)
                }
            }
        }
        act.onBackPressedDispatcher.addCallback(act, callback)
        cachedWebViewBackCallback = callback
    }

    private fun unregisterCachedWebViewBackHandler() {
        cachedWebViewBackCallback?.remove()
        cachedWebViewBackCallback = null
    }

    @PluginMethod
    fun fetch(call: PluginCall) {
        val url = call.getString("url") ?: return call.reject("url is required")
        val method = call.getString("method", "GET")?.uppercase() ?: "GET"
        val headersObj = call.getObject("headers")
        val body = call.getString("body")

        scope.launch {
            try {
                val request = Request.Builder().url(url).apply {
                    headersObj?.let { obj ->
                        val iter = obj.keys()
                        while (iter.hasNext()) {
                            val key = iter.next()
                            obj.getString(key)?.let { header(key, it) }
                        }
                    }
                    // Attach body for state-changing methods (login, submissions).
                    // Non-GET requests bypass the cache inside CacheInterceptor.
                    if (body != null && method != "GET" && method != "HEAD") {
                        val contentType = headersObj?.getString("Content-Type")
                            ?: headersObj?.getString("content-type")
                            ?: "application/json"
                        method(method, body.toRequestBody(contentType.toMediaType()))
                    } else {
                        method(method, null)
                    }
                }.build()

                val response = okHttpClient.newCall(request).execute()
                val bodyString = response.body?.string() ?: ""
                val contentType = response.header("Content-Type") ?: "application/octet-stream"
                response.close()

                val result = JSObject().apply {
                    put("ok", response.isSuccessful)
                    put("status", response.code)
                    put("body", bodyString)
                    put("contentType", contentType)
                }
                call.resolve(result)
            } catch (e: Exception) {
                Log.e(TAG, "fetch error", e)
                call.reject("Fetch failed: ${e.message}")
            }
        }
    }

    @PluginMethod
    fun openCachedWebView(call: PluginCall) {
        val url = call.getString("url") ?: return call.reject("url is required")
        val closeButtonText = call.getString("closeButtonText", "Close") ?: "Close"
        val showToolbar = call.getBoolean("showToolbar", true) ?: true
        // Demo mode is a property of the SERVER, so the overlay header has to say
        // it too: the form is where sample data actually gets edited.
        val demoMode = call.getBoolean("demoMode", false) ?: false
        val demoModeLabel = call.getString("demoModeLabel") ?: "DEMO MODE"
        // RESPECT-launched lessons (opened via a deep link from the launcher):
        // closing or backing out of them returns the user to the launcher.
        val launchedFromRespect = call.getBoolean("launchedFromRespect", false) ?: false
        val ipcPackageParam = call.getString("ipcPackage")

        val activity = activity ?: return call.reject("Activity not available")
        activity.runOnUiThread {
            try {
                // If a cached WebView is somehow still open, remove it first — a fresh
                // open supersedes any earlier one.
                currentWebViewRoot?.let { prevRoot ->
                    (prevRoot.parent as? ViewGroup)?.removeView(prevRoot)
                    unregisterCachedWebViewBackHandler()
                    hideOverlayLoading()
                    currentLoadingView = null
                    overlayContentFrame = null
                    currentWebViewRoot = null
                    currentWebView = null
                    currentRespectLaunch = false
                    currentIpcPackage = null
                    closeIpcClient()
                }

                val rootLayout = LinearLayout(activity).apply {
                    orientation = LinearLayout.VERTICAL
                    layoutParams = ViewGroup.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT
                    )
                }

                if (showToolbar) {
                    val toolbar = LinearLayout(activity).apply {
                        orientation = LinearLayout.HORIZONTAL
                        setBackgroundColor(Color.parseColor("#212a3f"))
                        setPadding(8, 4, 8, 4)
                        layoutParams = LinearLayout.LayoutParams(
                            LinearLayout.LayoutParams.MATCH_PARENT,
                            LinearLayout.LayoutParams.WRAP_CONTENT
                        )
                    }
                    // Back button (left end). Material arrow_back vector, the same
                    // glyph RESPECT renders via Icons.AutoMirrored.Filled.ArrowBack
                    // (the old text glyph "←" had no consistent stroke weight).
                    val backBtn = ImageView(activity).apply {
                        setImageResource(R.drawable.ic_arrow_back)
                        contentDescription = "Back"
                        setPadding(16, 16, 16, 16)
                        setOnClickListener {
                            closeCachedWebView(rootLayout)
                        }
                    }
                    toolbar.addView(backBtn)
                    // Spacer
                    val spacer = TextView(activity).apply {
                        layoutParams = LinearLayout.LayoutParams(
                            0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f
                        )
                    }
                    toolbar.addView(spacer)
                    // Demo-mode pill, centred between the two buttons. A form opens in
                    // its own WebView with its own native toolbar, so without this the
                    // pill vanished exactly where sample data is edited.
                    if (demoMode) {
                        toolbar.addView(buildDemoModeBadge(activity, demoModeLabel))
                        // Mirrors the left spacer, so the badge lands in the middle
                        // instead of hugging the close button.
                        toolbar.addView(TextView(activity).apply {
                            layoutParams = LinearLayout.LayoutParams(
                                0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f
                            )
                        })
                    }
                    // Close button (right end). Material close vector, matching
                    // RESPECT's Icons.Filled.Close.
                    val closeBtn = ImageView(activity).apply {
                        setImageResource(R.drawable.ic_close)
                        contentDescription = closeButtonText
                        setPadding(16, 16, 16, 16)
                        setOnClickListener {
                            closeCachedWebView(rootLayout)
                        }
                    }
                    toolbar.addView(closeBtn)

                    // Android 15+ (targetSdk 35+) draws the app edge-to-edge, so this
                    // overlay would otherwise start underneath the status bar. Keep the
                    // toolbar's background spanning the inset while shifting its buttons
                    // down so they stay visible and tappable.
                    val baseToolbarPadding = intArrayOf(
                        toolbar.paddingLeft, toolbar.paddingTop,
                        toolbar.paddingRight, toolbar.paddingBottom
                    )
                    ViewCompat.setOnApplyWindowInsetsListener(toolbar) { view, insets ->
                        val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
                        view.setPadding(
                            baseToolbarPadding[0],
                            baseToolbarPadding[1] + bars.top,
                            baseToolbarPadding[2],
                            baseToolbarPadding[3]
                        )
                        insets
                    }

                    rootLayout.addView(toolbar)
                }

                // Content area: a frame holding the WebView and the loader that
                // covers it while the form loads (see buildOverlayLoadingView).
                // A frame, not another row, so the loader sits ON TOP of the page
                // instead of splitting the column with it.
                val contentFrame = FrameLayout(activity).apply {
                    layoutParams = LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.MATCH_PARENT,
                        0, 1f
                    )
                }
                val loadingView = buildOverlayLoadingView(activity).apply {
                    layoutParams = FrameLayout.LayoutParams(
                        FrameLayout.LayoutParams.MATCH_PARENT,
                        FrameLayout.LayoutParams.MATCH_PARENT
                    )
                }

                val webView = WebView(activity).apply {
                    layoutParams = FrameLayout.LayoutParams(
                        FrameLayout.LayoutParams.MATCH_PARENT,
                        FrameLayout.LayoutParams.MATCH_PARENT
                    )
                    settings.javaScriptEnabled = true
                    settings.domStorageEnabled = true
                    settings.setGeolocationEnabled(true) // required for location field types
                    settings.allowFileAccess = false
                    settings.cacheMode = android.webkit.WebSettings.LOAD_DEFAULT
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        settings.safeBrowsingEnabled = false
                    }
                    webViewClient = CachingWebViewClient()
                    // Camera/mic/geolocation requests and <input type=file capture>
                    // would be silently denied without a WebChromeClient.
                    webChromeClient = CachedFormsWebChromeClient()
                    addJavascriptInterface(
                        TangyCacheFormBridge(okHttpClient, pendingDir(), gson),
                        "TangyCacheBridge"
                    )
                }
                // Keep the form's own bottom controls clear of the navigation bar.
                val baseWebViewPadding = intArrayOf(
                    webView.paddingLeft, webView.paddingTop,
                    webView.paddingRight, webView.paddingBottom
                )
                ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
                    val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
                    view.setPadding(
                        baseWebViewPadding[0],
                        baseWebViewPadding[1],
                        baseWebViewPadding[2],
                        baseWebViewPadding[3] + bars.bottom
                    )
                    insets
                }

                contentFrame.addView(webView)
                // Added last so it draws over the WebView's unstyled white page.
                contentFrame.addView(loadingView)
                rootLayout.addView(contentFrame)
                overlayContentFrame = contentFrame
                currentLoadingView = loadingView

                activity.addContentView(
                    rootLayout,
                    ViewGroup.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT
                    )
                )
                // Insets are dispatched on the next layout pass; nudge them along so
                // the overlay is positioned correctly the first time it is shown.
                rootLayout.post { ViewCompat.requestApplyInsets(rootLayout) }

                // Track the overlay so closing / backing out of it knows where to
                // land: RESPECT-launched lessons return to the launcher that opened
                // them; any other form just reveals the Tangerine page underneath.
                val respectIpc = ipcPackageParam?.takeIf { it.isNotBlank() }
                    ?: urlRespectIpcPackage(url)
                currentWebViewRoot = rootLayout
                currentWebView = webView
                currentRespectLaunch = launchedFromRespect || respectIpc != null
                currentIpcPackage = respectIpc
                registerCachedWebViewBackHandler()

                webView.loadUrl(url)
                call.resolve()
            } catch (e: Exception) {
                Log.e(TAG, "openCachedWebView error", e)
                call.reject("openCachedWebView failed: ${e.message}")
            }
        }
    }

    @PluginMethod
    fun store(call: PluginCall) {
        val url = call.getString("url") ?: return call.reject("url is required")
        val mimeType = call.getString("mimeType") ?: "application/octet-stream"
        val body = call.getString("body") ?: return call.reject("body is required")
        val headersObj = call.getObject("headers")
        val headers = headersObj?.let { obj ->
            val map = mutableMapOf<String, String>()
            val iter = obj.keys()
            while (iter.hasNext()) {
                val key = iter.next()
                obj.getString(key)?.let { map[key] = it }
            }
            map
        }
        scope.launch {
            try {
                storeOnDisk(url, mimeType, body, headers)
                call.resolve()
            } catch (e: Exception) {
                Log.e(TAG, "store error", e)
                call.reject("Store failed: ${e.message}")
            }
        }
    }

    @PluginMethod
    fun retrieve(call: PluginCall) {
        val url = call.getString("url") ?: return call.reject("url is required")
        scope.launch {
            try {
                val cached = retrieveFromDisk(url)
                if (cached == null) {
                    call.resolve(null)
                    return@launch
                }
                val (body, meta) = cached
                val headersObj = JSObject()
                meta.headers.forEach { (k, v) -> headersObj.put(k, v) }
                val result = JSObject().apply {
                    put("body", body)
                    put("mimeType", meta.mimeType)
                    put("headers", headersObj)
                }
                call.resolve(result)
            } catch (e: Exception) {
                Log.e(TAG, "retrieve error", e)
                call.reject("Retrieve failed: ${e.message}")
            }
        }
    }

    @PluginMethod
    fun isCached(call: PluginCall) {
        val url = call.getString("url") ?: return call.reject("url is required")
        val filename = urlToFilename(url)
        call.resolve(JSObject().apply {
            put("cached", File(cacheDir(), filename).exists())
        })
    }

    /**
     * Cache metadata for one or more URLs, without reading the bodies.
     *
     * The JS layer uses this to decide whether a pinned form is stale: it
     * compares the server's publication `metadata.modified` with the `Date`
     * header the server itself sent when the copy was stored (falling back to
     * the local storedAt). Using the server's own clock avoids marking every
     * form stale on a device whose clock is ahead.
     */
    @PluginMethod
    fun getCacheInfo(call: PluginCall) {
        val urlsArray = call.getArray("urls") ?: run {
            val single = call.getString("url")
                ?: return call.reject("urls is required")
            JSArray().apply { put(single) }
        }

        val entries = JSArray()
        for (i in 0 until urlsArray.length()) {
            val url = urlsArray.optString(i)
            if (url.isNullOrEmpty()) continue

            val meta = readMeta(url)
            entries.put(JSObject().apply {
                put("url", url)
                put("cached", File(cacheDir(), urlToFilename(url)).exists())
                put("storedAt", meta?.storedAt ?: 0L)
                put("sizeBytes", meta?.sizeBytes ?: 0L)
                put("etag", meta?.let { metaHeader(it, "etag") } ?: "")
                put("lastModified", meta?.let { metaHeader(it, "last-modified") } ?: "")
                put("cacheControl", meta?.let { metaHeader(it, "cache-control") } ?: "")
                put("serverDate", meta?.let { metaHeader(it, "date") } ?: "")
            })
        }

        call.resolve(JSObject().apply { put("entries", entries) })
    }

    @PluginMethod
    fun evict(call: PluginCall) {
        val urlsArray = call.getArray("urls") ?: return call.reject("urls is required")
        scope.launch {
            try {
                var removed = 0
                for (i in 0 until urlsArray.length()) {
                    val url = urlsArray.optString(i)
                    if (url.isEmpty()) continue
                    val filename = urlToFilename(url)
                    if (File(cacheDir(), filename).delete()) removed++
                    File(metaDir(), "$filename.json").delete()
                }
                Log.d(TAG, "evict removed $removed entries")
                call.resolve(JSObject().apply { put("removed", removed) })
            } catch (e: Exception) {
                Log.e(TAG, "evict error", e)
                call.reject("Evict failed: ${e.message}")
            }
        }
    }

    @PluginMethod
    fun downloadAndRetain(call: PluginCall) {
        val urlsArray = call.getArray("urls") ?: return call.reject("urls is required")
        scope.launch {
            try {
                val urlList = mutableListOf<String>()
                for (i in 0 until urlsArray.length()) {
                    val jsonObj = urlsArray.optJSONObject(i) ?: continue
                    val obj = JSObject.fromJSONObject(jsonObj)
                    obj.getString("url")?.let { urlList.add(it) }
                }
                val jobId = UUID.randomUUID().toString()
                pinJobs[jobId] = PinJob(jobId, urlList, System.currentTimeMillis())
                for (url in urlList) {
                    try {
                        val request = Request.Builder().url(url).build()
                        val response = okHttpClient.newCall(request).execute()
                        response.body?.bytes()
                        response.close()
                    } catch (e: Exception) {
                        Log.w(TAG, "Failed to download $url: ${e.message}")
                    }
                }
                call.resolve(JSObject().apply { put("jobId", jobId) })
            } catch (e: Exception) {
                Log.e(TAG, "downloadAndRetain error", e)
                call.reject("downloadAndRetain failed: ${e.message}")
            }
        }
    }

    @PluginMethod
    fun release(call: PluginCall) {
        val jobId = call.getString("jobId") ?: return call.reject("jobId is required")
        scope.launch {
            val job = pinJobs.remove(jobId)
            if (job != null) {
                for (url in job.urls) {
                    val filename = urlToFilename(url)
                    File(cacheDir(), filename).delete()
                    File(metaDir(), "$filename.json").delete()
                }
            }
            call.resolve()
        }
    }

    @PluginMethod
    fun getPinProgress(call: PluginCall) {
        call.resolve(JSObject().apply {
            put("progress", JSObject().apply {
                put("status", "not-pinned")
                put("totalSize", 0)
                put("transferred", 0)
            })
        })
    }

    @PluginMethod
    fun getStats(call: PluginCall) {
        scope.launch {
            try {
                val files = cacheDir().listFiles() ?: emptyArray()
                val totalSize = files.filter { it.isFile }.sumOf { it.length() }
                call.resolve(JSObject().apply {
                    put("stats", JSObject().apply {
                        put("entryCount", files.count { it.isFile })
                        put("totalSizeBytes", totalSize)
                        put("sizeLimitBytes", 500L * 1024 * 1024)
                    })
                })
            } catch (e: Exception) {
                Log.e(TAG, "getStats error", e)
                call.reject("getStats failed: ${e.message}")
            }
        }
    }

    @PluginMethod
    fun clear(call: PluginCall) {
        scope.launch {
            try {
                cacheDir().listFiles()?.forEach { it.delete() }
                metaDir().listFiles()?.forEach { it.delete() }
                pinJobs.clear()
                call.resolve()
            } catch (e: Exception) {
                Log.e(TAG, "clear error", e)
                call.reject("Clear failed: ${e.message}")
            }
        }
    }

    @PluginMethod
    fun setDistributedCachingEnabled(call: PluginCall) {
        call.resolve()
    }

    // ── RESPECT-compatible proxy server ──────────────────────────────────

    @PluginMethod
    fun startProxy(call: PluginCall) {
        val port = call.getInt("port", 4242) ?: 4242
        if (proxyServer?.listeningPort != port) {
            proxyServer?.stop()
            proxyServer = CacheProxyServer(okHttpClient, port)
            proxyServer!!.start()
            Log.d(TAG, "Proxy started on port $port")
        }
        val result = JSObject().apply {
            put("port", port)
            put("running", true)
        }
        call.resolve(result)
    }

    @PluginMethod
    fun stopProxy(call: PluginCall) {
        proxyServer?.stop()
        proxyServer = null
        call.resolve()
    }

    @PluginMethod
    fun isProxyRunning(call: PluginCall) {
        val result = JSObject().apply {
            put("running", proxyServer != null)
            put("port", proxyServer?.listeningPort ?: 0)
        }
        call.resolve(result)
    }

    // ── Offline form submission queue ────────────────────────────────────

    @PluginMethod
    fun submitForm(call: PluginCall) {
        val url = call.getString("url") ?: return call.reject("url is required")
        val body = call.getString("body") ?: return call.reject("body is required")
        val method = call.getString("method", "POST") ?: "POST"

        scope.launch {
            try {
                // Try sending immediately
                val request = Request.Builder().url(url).method(method, body.toRequestBody(null)).build()
                val response = okHttpClient.newCall(request).execute()
                val respBody = response.body?.string() ?: ""
                val result = JSObject().apply {
                    put("ok", response.isSuccessful)
                    put("status", response.code)
                    put("body", respBody)
                    put("queued", false)
                }
                response.close()
                call.resolve(result)
            } catch (e: Exception) {
                // Offline — queue for later
                val id = UUID.randomUUID().toString()
                val headers = mutableMapOf<String, String>()
                call.getObject("headers")?.let { obj ->
                    val iter = obj.keys()
                    while (iter.hasNext()) {
                        val key = iter.next()
                        obj.getString(key)?.let { headers[key] = it }
                    }
                }
                val submission = PendingSubmission(id, url, method, headers, body, System.currentTimeMillis())
                File(pendingDir(), "$id.json").writeText(gson.toJson(submission), Charsets.UTF_8)
                Log.i(TAG, "Queued submission $id for $url (offline)")
                call.resolve(JSObject().apply {
                    put("ok", false)
                    put("queued", true)
                    put("id", id)
                    put("error", e.message)
                })
            }
        }
    }

    @PluginMethod
    fun getPendingCount(call: PluginCall) {
        call.resolve(JSObject().apply { put("count", pendingFiles().size) })
    }

    @PluginMethod
    fun syncPending(call: PluginCall) {
        scope.launch {
            try {
                val result = drainPendingQueue()
                // Null means the automatic post-reconnect drain already owns the
                // queue. Reporting 0/0 would read as "nothing to upload", which
                // is wrong while an upload is in flight — say so instead.
                if (result == null) {
                    call.resolve(JSObject().apply {
                        put("synced", 0)
                        put("failed", 0)
                        put("xapiSynced", 0)
                        put("remaining", pendingFiles().size)
                        put("skipped", true)
                    })
                    return@launch
                }
                val (synced, failed) = result
                // Also attempt delivery of queued xAPI statement batches.
                var xapiSynced = 0
                try {
                    xapiSynced = replayQueuedXapi()
                } catch (e: Exception) {
                    Log.w(TAG, "syncPending xAPI replay error: ${e.message}")
                }
                call.resolve(JSObject().apply {
                    put("synced", synced)
                    put("failed", failed)
                    put("xapiSynced", xapiSynced)
                    put("remaining", pendingFiles().size)
                    put("skipped", false)
                })
            } catch (e: Exception) {
                call.reject("Sync failed: ${e.message}")
            }
        }
    }

    @PluginMethod
    fun clearPending(call: PluginCall) {
        pendingFiles().forEach { it.delete() }
        call.resolve()
    }

    // ── Offline submission drain ─────────────────────────────────────────

    /**
     * Every queued submission still on disk, including files a drain has
     * already claimed. Counting both keeps the badge honest while an upload is
     * in flight (a claimed response has not been delivered yet).
     */
    private fun pendingFiles(): List<File> =
        pendingDir().listFiles()
            ?.filter {
                it.isFile && (it.name.endsWith(".json") || it.name.endsWith(SENDING_SUFFIX))
            }
            ?: emptyList()

    /**
     * Upload every queued submission once.
     *
     * Each file is renamed to `<id>.json.sending` before the POST so a
     * concurrent drain cannot pick it up, and it is only deleted when the
     * server ACCEPTED it. A rejected (4xx/5xx) or failed submission stays on
     * disk: it is the user's data, and the previous implementation deleted it
     * on any non-2xx response.
     *
     * @returns synced to failed counts, or null when another drain holds the lock.
     */
    private suspend fun drainPendingQueue(): Pair<Int, Int>? {
        if (!pendingDrainLock.compareAndSet(false, true)) {
            Log.i(TAG, "A pending drain is already running; skipping this one")
            return null
        }
        var synced = 0
        var failed = 0
        try {
            for (queued in pendingFiles()) {
                val claimed = claimPending(queued) ?: continue
                if (uploadPending(claimed)) {
                    claimed.delete()
                    synced++
                } else {
                    failed++
                    releaseClaim(claimed)
                }
            }
        } finally {
            pendingDrainLock.set(false)
        }
        Log.i(TAG, "Pending drain finished: $synced uploaded, $failed kept for retry")
        return synced to failed
    }

    /** Rename `<id>.json` to `<id>.json.sending`. Null when another drain won. */
    private fun claimPending(file: File): File? {
        // Already claimed by a drain that died before finishing — take it over.
        if (file.name.endsWith(SENDING_SUFFIX)) return file
        val target = File(file.parentFile, file.name + SENDING_SUFFIX)
        return if (file.renameTo(target)) target else null
    }

    /** Give a claimed file back to the queue so the next drain retries it. */
    private fun releaseClaim(file: File) {
        val back = File(file.parentFile, file.name.removeSuffix(SENDING_SUFFIX))
        if (!file.renameTo(back)) Log.w(TAG, "Could not release claim on ${file.name}")
    }

    /** POST one claimed submission. False on rejection OR network failure. */
    private fun uploadPending(file: File): Boolean {
        return try {
            val submission = gson.fromJson(file.readText(Charsets.UTF_8), PendingSubmission::class.java)
            val request = Request.Builder().url(submission.url)
                .method(submission.method, submission.body.toRequestBody(null))
                .apply {
                    submission.headers.forEach { (k, v) -> addHeader(k, v) }
                }
                .build()
            val response = okHttpClient.newCall(request).execute()
            val accepted = response.isSuccessful
            if (!accepted) {
                Log.w(TAG, "Server rejected queued submission ${file.name}: HTTP ${response.code}")
            }
            response.close()
            accepted
        } catch (e: Exception) {
            Log.w(TAG, "Upload failed for ${file.name}: ${e.message}")
            false
        }
    }

    /**
     * Forward xAPI statements (generated client-side in the lesson WebView by the form player)
     * back to the RESPECT / Open Educational Experience Launcher that launched this lesson,
     * using the launcher's xAPI-over-IPC service. This app does NOT originate statements — it
     * only relays the ones it is given, so the launcher can forward them to the real LRS.
     */
    @PluginMethod
    fun forwardXapiStatements(call: PluginCall) {
        val endpoint = call.getString("endpoint")
            ?: return call.reject("endpoint is required")
        val auth = call.getString("auth")
            ?: return call.reject("auth is required")
        val ipcPackage = call.getString("ipcPackage")
            ?: return call.reject("ipcPackage is required")
        val statementsJson = call.getString("statementsJson")
            ?: return call.reject("statementsJson is required")

        forwardStatementsViaIpc(endpoint, auth, ipcPackage, statementsJson) { ok, count, result ->
            if (ok) {
                call.resolve(JSObject().apply {
                    put("ok", true)
                    put("count", count)
                    put("result", result)
                })
            } else {
                call.reject("forwardXapiStatements failed: $result")
            }
        }
    }

    /**
     * Hand a batch of xAPI statements to the native delivery queue (disk + a
     * connectivity-constrained WorkManager job) instead of letting the lesson WebView
     * try to deliver it itself. Returns true once the batch is durable, which is the
     * signal the caller uses to drop its own copy. Synchronous by design: the WebView
     * must not clear its outbox entry before the batch is safely stored here.
     */
    @PluginMethod
    fun queueXapiStatements(call: PluginCall) {
        val endpoint = call.getString("endpoint")
            ?: return call.reject("endpoint is required")
        val auth = call.getString("auth")
            ?: return call.reject("auth is required")
        val ipcPackage = call.getString("ipcPackage")
            ?: return call.reject("ipcPackage is required")
        val statementsJson = call.getString("statementsJson")
            ?: return call.reject("statementsJson is required")

        val ctx = contextForWork()
        val queued = XapiDelivery.accept(ctx, endpoint, auth, ipcPackage, statementsJson)
        call.resolve(JSObject().apply {
            put("ok", queued)
            put("pending", XapiDelivery.pendingCount(ctx))
        })
    }

    /** Blocking (suspend) delivery of one xAPI batch to the launcher over IPC. */
    private suspend fun deliverXapiNow(endpoint: String, auth: String, ipcPackage: String, statementsJson: String): Boolean =
        XapiDelivery.deliver(
            contextForWork(),
            PendingXapi("", endpoint, auth, ipcPackage, statementsJson, 0L)
        )

    /** Replay every queued xAPI batch; returns how many were delivered. */
    private suspend fun replayQueuedXapi(): Int = XapiDelivery.deliverPending(contextForWork())

    /**
     * Shared relay used by both the Capacitor @PluginMethod and the WebView TangyCacheBridge.
     * Runs off the main thread; onResult is invoked on the plugin's IO scope.
     *
     * When the launcher cannot be reached *or* the launcher cannot reach the LRS, the batch
     * is handed to [XapiDelivery] instead of being dropped: it is written to disk and a
     * connectivity-constrained WorkManager job takes over, so delivery survives the app
     * being killed before the network comes back. "ok" therefore means "delivered or
     * durably queued" - the caller may drop its own copy either way.
     */
    private fun forwardStatementsViaIpc(
        endpoint: String,
        auth: String,
        ipcPackage: String,
        statementsJson: String,
        queueOnFailure: Boolean = true,
        onResult: ((ok: Boolean, count: Int, result: String) -> Unit)? = null
    ) {
        val ctx = activity?.applicationContext
        if (ctx == null) {
            Log.e(TAG, "forwardXapiStatements failed: activity not available")
            onResult?.invoke(false, 0, "Activity not available")
            return
        }
        scope.launch {
            val delivered = deliverXapiNow(endpoint, auth, ipcPackage, statementsJson)
            var ok = delivered
            var result = if (delivered) "delivered" else "failed"
            if (!delivered && queueOnFailure) {
                // attemptNow = false: this path has just tried the IPC hop itself.
                ok = XapiDelivery.accept(
                    ctx, endpoint, auth, ipcPackage, statementsJson, attemptNow = false
                )
                result = if (ok) "queued" else "failed"
            }
            onResult?.invoke(ok, 0, result)
        }
    }

    /**
     * Close the RESPECT-launched lesson and return the user to the launcher app that opened it.
     * Called once the form has been submitted (the xAPI relay only fires for RESPECT-launched
     * lessons, at completion). Brings the launcher's task back to the foreground (best-effort)
     * and finishes this activity, per the RESPECT "finish when the learning unit is complete"
     * contract.
     */
    private fun finishAndReturnToLauncher(ipcPackage: String?) {
        val ctx = activity ?: return
        ctx.runOnUiThread {
            try {
                if (!ipcPackage.isNullOrBlank()) {
                    val launch = Intent(Intent.ACTION_MAIN)
                        .addCategory(Intent.CATEGORY_LAUNCHER)
                        .setPackage(ipcPackage)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    ctx.startActivity(launch)
                }
            } catch (e: Exception) {
                Log.w(TAG, "finishAndReturnToLauncher: could not bring launcher forward", e)
            } finally {
                ctx.finish()
            }
        }
    }

    override fun load() {
        super.load()
        registerActivityLaunchers()
        registerConnectivitySync()
        // WorkManager holds the xAPI delivery job across process death; re-arm it here
        // in case the device went offline while this app was not running.
        XapiDelivery.enqueueIfPending(contextForWork())
    }

    /**
     * Activity Result launchers must be registered before the Activity reaches
     * STARTED. Plugin load() runs during onCreate, so we register here once and
     * reuse the launchers for every cached WebView opened afterwards.
     */
    private fun registerActivityLaunchers() {
        val br = bridge ?: return
        permissionLauncher = br.registerForActivityResult(
            ActivityResultContracts.RequestMultiplePermissions()
        ) { result ->
            val granted = result.values.all { it }
            val action = pendingPermissionAction
            pendingPermissionAction = null
            action?.invoke(granted)
        }
        fileChooserLauncher = br.registerForActivityResult(
            ActivityResultContracts.StartActivityForResult()
        ) { result ->
            resolveFileChooserResult(result)
        }
    }

    override fun handleOnDestroy() {
        proxyServer?.stop()
        connectivityCallback?.let {
            (activity?.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager)
                ?.unregisterNetworkCallback(it)
        }
        super.handleOnDestroy()
    }

    private fun registerConnectivitySync() {
        val cm = activity?.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                Log.i(TAG, "Network available — syncing pending submissions")
                scope.launch {
                    try {
                        drainPendingQueue()
                        // Replay xAPI statements queued while the launcher IPC was down.
                        try {
                            replayQueuedXapi()
                        } catch (e: Exception) {
                            Log.w(TAG, "Auto xAPI replay error: ${e.message}")
                        }
                    } catch (e: Exception) {
                        Log.e(TAG, "Auto-sync error", e)
                    }
                }
            }
        }
        connectivityCallback = callback
        val networkRequest = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()
        cm.registerNetworkCallback(networkRequest, callback)
    }

    /**
     * JavaScript interface injected into cached WebViews.
     * Form submissions call this bridge instead of going directly to the network,
     * so they can be queued offline via TangyCache.submitForm().
     */
    inner class TangyCacheFormBridge(
        private val okHttpClient: OkHttpClient,
        private val pendingDir: File,
        private val gson: Gson
    ) {
        @android.webkit.JavascriptInterface
        fun submitForm(url: String, method: String, body: String, headersJson: String) {
            val headers = parseHeaderMap(headersJson)
            val httpMethod = method.ifBlank { "POST" }
            scope.launch {
                try {
                    val requestBuilder = Request.Builder().url(url)
                        .method(httpMethod, body.toRequestBody(null))
                    headers.forEach { (k, v) -> requestBuilder.addHeader(k, v) }
                    val response = okHttpClient.newCall(requestBuilder.build()).execute()
                    Log.i(TAG, "WebView form submitted: $httpMethod $url -> ${response.code}")
                    response.close()
                } catch (e: Exception) {
                    // Offline — queue for later (preserve headers so replay carries
                    // the upload token / content-type).
                    try {
                        val id = UUID.randomUUID().toString()
                        val submission = PendingSubmission(
                            id = id, url = url, method = httpMethod,
                            headers = headers, body = body,
                            createdAt = System.currentTimeMillis()
                        )
                        File(pendingDir, "$id.json").writeText(gson.toJson(submission))
                        Log.i(TAG, "WebView form queued offline: $id for $url")
                    } catch (e2: Exception) {
                        Log.e(TAG, "Failed to queue form submission", e2)
                    }
                }
            }
        }

        @android.webkit.JavascriptInterface
        fun getPendingCount(): Int {
            return pendingFiles().size
        }

        /**
         * Open this app's Android Settings page so the user can re-enable a
         * permission they previously denied. Called by the injected
         * permission-help banner's "Open Settings" button.
         */
        @android.webkit.JavascriptInterface
        fun openAppSettings() {
            val act = this@TangyCachePlugin.activity ?: return
            try {
                act.startActivity(
                    Intent(
                        Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.parse("package:${act.packageName}")
                    ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            } catch (e: Exception) {
                Log.e(TAG, "openAppSettings failed", e)
            }
        }

        /**
         * Forward xAPI statements from the lesson WebView (where Capacitor is NOT injected) back
         * to the RESPECT launcher that opened the lesson, via the launcher's xAPI-over-IPC
         * service. Fire-and-forget: results are logged on the native side.
         */
        @android.webkit.JavascriptInterface
        fun forwardXapiStatements(endpoint: String, auth: String, ipcPackage: String, statementsJson: String) {
            Log.i(TAG, "TangyCacheBridge.forwardXapiStatements called for $ipcPackage")
            this@TangyCachePlugin.forwardStatementsViaIpc(
                endpoint, auth, ipcPackage, statementsJson
            ) { ok, count, result ->
                Log.i(
                    TAG,
                    "TangyCacheBridge forwarded $count xAPI statements to $ipcPackage (ok=$ok): $result"
                )
                // The form was submitted in a RESPECT-launched lesson: close the lesson WebView
                // and hand the user back to the RESPECT launcher that opened it.
                this@TangyCachePlugin.finishAndReturnToLauncher(ipcPackage)
            }
        }

        /**
         * Called by the injected outbox mirror (XAPI_OUTBOX_MIRROR_SCRIPT). Takes ownership of
         * an xAPI batch the lesson WebView could not deliver: it is written to disk and a
         * connectivity-constrained WorkManager job delivers it to the launcher over IPC, even
         * if this app is killed before the network returns. Returns true only once the batch is
         * durable, so the caller can safely drop its own copy.
         */
        @android.webkit.JavascriptInterface
        fun queueXapiStatements(endpoint: String, auth: String, ipcPackage: String, statementsJson: String): Boolean {
            val queued = XapiDelivery.accept(
                this@TangyCachePlugin.contextForWork(), endpoint, auth, ipcPackage, statementsJson
            )
            Log.i(TAG, "TangyCacheBridge.queueXapiStatements($ipcPackage) -> queued=$queued")
            return queued
        }

        /**
         * Called by the injected form-submit watcher (FORM_SUBMIT_WATCH_SCRIPT) once a
         * form run in this WebView reaches the player's "form submitted" success
         * state. Forms opened from the Tangerine group/form list close and reveal
         * that list again. RESPECT-launched lessons are ignored here: their hand-back
         * to the launcher is driven by the xAPI IPC relay callback (above), so
         * closing here as well would return twice.
         */
        @android.webkit.JavascriptInterface
        fun formSubmitted() {
            val root = currentWebViewRoot ?: return
            if (currentRespectLaunch) return
            Log.i(TAG, "Form submitted - closing cached WebView back to the form list")
            activity?.runOnUiThread {
                // Guard against a newer overlay having replaced this one in the
                // meantime (reopened form while the close was posting).
                if (currentWebViewRoot === root) closeCachedWebView(root)
            }
        }
    }

    companion object {
        private const val TAG = "TangyCache"

        /**
         * Request marker the JS layer sends for an explicit refresh (the Sync
         * button / revalidation probe). CacheInterceptor treats its presence as
         * "ignore any fresh copy and revalidate now", then strips it so it is
         * never sent to the origin.
         */
        private const val HEADER_FORCE_REFRESH = "X-Tangy-Refresh"

        /**
         * Suffix a drain appends to a queued submission while uploading it, so a
         * second drain cannot pick up the same file and POST it twice.
         */
        private const val SENDING_SUFFIX = ".sending"

        /**
         * Probe marker: fetch the current bytes but do NOT store them. Used by
         * staleness checks, which must not overwrite the copy they compare
         * against.
         */
        private const val HEADER_NO_STORE = "X-Tangy-No-Store"

        /**
         * How long a cached-WebView load may run before its progress bar is
         * revealed. Pinned/offline forms paint in well under this; showing the bar
         * for them would be a flicker on every tap.
         */
        private const val OVERLAY_LOADING_GRACE_MS = 250L

        /** Identifies the load-failure view inside the overlay's root layout. */
        private const val OVERLAY_ERROR_TAG = "tangy-overlay-error"

        /**
         * JavaScript injected into every page loaded in a cached WebView.
         * Replaces the native form submit with a call to TangyCacheBridge,
         * which goes through the offline-capable native HTTP pipeline.
         */
        private const val FORM_INTERCEPT_SCRIPT = """
            (function() {
                if (window.__tangyFormInterceptorInjected) return;
                window.__tangyFormInterceptorInjected = true;
                document.addEventListener('submit', function(e) {
                    var form = e.target;
                    if (!form || !form.action) return;
                    e.preventDefault();
                    var data = new FormData(form);
                    var params = new URLSearchParams();
                    for (var pair of data.entries()) {
                        params.append(pair[0], pair[1]);
                    }
                    try {
                        TangyCacheBridge.submitForm(
                            form.action,
                            (form.method || 'GET').toUpperCase(),
                            params.toString(),
                            '{}'
                        );
                    } catch(err) {
                        console.warn('[TangyCache] Bridge submit failed:', err);
                        form.submit();
                    }
                });
            })();
        """

        /**
         * JavaScript injected into every cached WebView page: paints the form
         * player with the app's Tangerine palette.
         *
         * A release ships Angular Material's DEFAULT theme — indigo #3f51b5 and
         * pink #ff4081 — so the player looked like the old Polymer/violet build
         * next to a UI that is Tangerine navy/orange. The release's own sheet
         * already defines --primary-color #3c5b8d / --accent-color #f26f10 on
         * html,body, but Material's components read --mdc-theme-primary and
         * --mdc-theme-secondary and fall back to the defaults because the
         * release never sets them.
         *
         * Only custom properties are overridden — never element selectors — so
         * the form's layout, typography and behaviour are untouched. The
         * `html:root`/`body:root` specificity outranks the compiled
         * `html,body{...}` block, so the override wins regardless of the order
         * the stylesheets end up in.
         */
        private const val FORM_THEME_SCRIPT = """
            (function() {
                if (document.getElementById('tangy-theme-override')) return;
                var css = 'html:root, body:root {' +
                    '--mdc-theme-primary: #3c5b8d;' +
                    '--mdc-theme-on-primary: #ffffff;' +
                    '--mdc-theme-secondary: #f26f10;' +
                    '--mdc-theme-on-secondary: #ffffff;' +
                    '--mdc-theme-surface: #ffffff;' +
                    '--mdc-theme-on-surface: #212121;' +
                    '--mdc-theme-background: #f7f6f6;' +
                    '--primary-color: #3c5b8d;' +
                    '--primary-color-dark: #212a3f;' +
                    '--primary-text-color-overlay: #ffffff;' +
                    '--accent-color: #f26f10;' +
                    '--accent-color-dark: #cc5500;' +
                    '--accent-text-color: #ffffff;' +
                '}';
                var style = document.createElement('style');
                style.id = 'tangy-theme-override';
                style.appendChild(document.createTextNode(css));
                (document.head || document.documentElement).appendChild(style);
            })();
        """

        /**
         * JavaScript injected into every cached WebView page. When a RESPECT launcher opened this
         * lesson (xapiIpcPackage is present in the URL), it wraps ADL.XAPIWrapper so the xAPI
         * statements the form player sends (ADL.XAPIWrapper.sendStatements) are relayed back to
         * the RESPECT launcher over its xAPI-over-IPC service instead of being POSTed to a local
         * endpoint that is unreachable from Tangerine's WebView. No form-player/server change is
         * required — this runs entirely inside the app's WebView. Non-launched lessons are left
         * untouched (the launcher's xapiIpcPackage is absent).
         */
        private const val XAPI_RELAY_SCRIPT = """
            (function() {
                if (window.__tangyXapiRelayInjected) return;
                window.__tangyXapiRelayInjected = true;

                var params = new URLSearchParams(window.location.search || '');
                var ipcPackage = params.get('xapiIpcPackage') || '';
                var hasBridge = false;
                try { hasBridge = !!(window.TangyCacheBridge && TangyCacheBridge.forwardXapiStatements); } catch (e) {}
                if (!ipcPackage || !hasBridge) return;

                function install() {
                    if (!window.ADL || !window.ADL.XAPIWrapper) return false;
                    var wrapper = window.ADL.XAPIWrapper;
                    if (wrapper.__tangyRelayInstalled) return true;
                    wrapper.__tangyRelayInstalled = true;
                    console.log('[TangyCache] XAPI relay installed for launcher ' + ipcPackage);

                    var endpoint = '';
                    var auth = '';

                    var origChangeConfig = wrapper.changeConfig;
                    wrapper.changeConfig = function(cfg) {
                        if (cfg) {
                            if (cfg.endpoint) endpoint = cfg.endpoint;
                            if (cfg.auth) auth = cfg.auth;
                        }
                        if (origChangeConfig) return origChangeConfig.apply(this, arguments);
                    };

                    var origSend = wrapper.sendStatements;
                    wrapper.sendStatements = function(statements) {
                        if (endpoint && auth) {
                            try {
                                console.log('[TangyCache] Relaying xAPI statements to launcher ' + ipcPackage);
                                TangyCacheBridge.forwardXapiStatements(
                                    endpoint, auth, ipcPackage, JSON.stringify(statements || [])
                                );
                                return null;
                            } catch (e) {
                                console.error('[TangyCache] xAPI IPC relay failed; falling back to direct send', e);
                            }
                        }
                        if (origSend) return origSend.apply(this, arguments);
                    };
                    return true;
                }

                // ADL.XAPIWrapper may not exist yet on first paint; the form is submitted later,
                // so poll briefly until it is available and patched.
                var attempts = 0;
                (function tryInstall() {
                    if (install()) return;
                    if (++attempts > 200) return; // ~20s cap
                    setTimeout(tryInstall, 100);
                })();
            })();
        """

        /**
         * JavaScript injected into every cached WebView page.
         *
         * The form player keeps batches it cannot deliver in its own localStorage outbox
         * (it refuses to relay at all while navigator.onLine is false). That outbox only has
         * two exits: a Capacitor plugin call (unavailable here - this WebView has no Capacitor
         * bridge) or a direct POST to the LRS, which fails from inside the app's WebView. So a
         * batch submitted offline ends up stranded: retried forever, delivered never.
         *
         * This mirror moves such batches into the native delivery queue instead: any outbox
         * item that names a launcher IPC package is handed to TangyCacheBridge
         * .queueXapiStatements, which stores it on disk, tries the IPC hop to the launcher
         * immediately (offline included - it is a local Binder call), and arms a
         * connectivity-constrained WorkManager job for the retries. The item is then removed
         * from the outbox, so there is exactly ONE owner of the batch. Delivery no longer
         * depends on this page, or even on this app, staying alive until the network returns.
         *
         * Batches are handed over eagerly (on the outbox write that queued them and on every
         * page load for anything left behind), and the native side is content-addressed, so a
         * batch that is offered twice is still delivered once.
         */
        private const val XAPI_OUTBOX_MIRROR_SCRIPT = """
            (function() {
                if (window.__tangyXapiOutboxMirrorInjected) return;
                window.__tangyXapiOutboxMirrorInjected = true;

                var hasBridge = false;
                try { hasBridge = !!(window.TangyCacheBridge && TangyCacheBridge.queueXapiStatements); } catch (e) {}
                if (!hasBridge) return;

                // Matches the offline outbox key(s) without hard-coding a version.
                var OUTBOX_KEY_RE = /outbox/i;
                var origSetItem = Storage.prototype.setItem;

                function handOff(item) {
                    if (!item || item.type !== 'xapi-statements') return false;
                    if (!item.endpoint || !item.auth || !item.ipcPackage) return false;
                    if (!item.statements || !item.statements.length) return false;
                    try {
                        var ok = TangyCacheBridge.queueXapiStatements(
                            item.endpoint, item.auth, item.ipcPackage, JSON.stringify(item.statements)
                        );
                        if (ok === true) {
                            console.log('[TangyCache] Handed a queued xAPI batch to the native delivery queue');
                        }
                        return ok === true;
                    } catch (e) {
                        return false;
                    }
                }

                // Returns the items left for the page to keep, or null when nothing moved.
                function drain(raw) {
                    var items;
                    try { items = JSON.parse(raw); } catch (e) { return null; }
                    if (!items || typeof items.length !== 'number') return null;
                    var kept = [];
                    var moved = 0;
                    for (var i = 0; i < items.length; i++) {
                        if (handOff(items[i])) { moved++; } else { kept.push(items[i]); }
                    }
                    return moved ? kept : null;
                }

                Storage.prototype.setItem = function(key, value) {
                    try {
                        if (typeof key === 'string' && typeof value === 'string' && OUTBOX_KEY_RE.test(key)) {
                            var kept = drain(value);
                            if (kept !== null) value = JSON.stringify(kept);
                        }
                    } catch (e) {}
                    return origSetItem.call(this, key, value);
                };

                // Anything already stranded by an earlier page load or an earlier launch.
                try {
                    for (var i = 0; i < localStorage.length; i++) {
                        var k = localStorage.key(i);
                        if (k && OUTBOX_KEY_RE.test(k)) {
                            var kept = drain(localStorage.getItem(k));
                            if (kept !== null) origSetItem.call(localStorage, k, JSON.stringify(kept));
                        }
                    }
                } catch (e) {}
            })();
        """

        /**
         * JavaScript injected into every cached WebView page. Watches for the
         * online-survey-app form player's "form submitted" state and asks the native
         * side to close the overlay - so a form opened from the Tangerine group/form
         * list returns to that list, mirroring the RESPECT-launched hand-back.
         *
         * The player uploads the completed response and delivers its xAPI statements
         * BEFORE routing to its 'form-submitted-success' Angular route, so that route
         * is the "submission finished" signal (closing earlier would drop what is
         * still in flight). The route is hash-based: Angular's HashLocationStrategy
         * navigates with history.pushState/replaceState, which fires neither
         * hashchange nor popstate - hence the history hooks. hashchange/popstate and
         * a short poll started by the form's 'after-submit' event are safety nets for
         * other player builds.
         */
        private const val FORM_SUBMIT_WATCH_SCRIPT = """
            (function() {
                if (window.__tangyFormSubmitWatchInjected) return;
                window.__tangyFormSubmitWatchInjected = true;

                var hasBridge = false;
                try { hasBridge = !!(window.TangyCacheBridge && TangyCacheBridge.formSubmitted); } catch (e) {}
                if (!hasBridge) return;

                var SUCCESS_MARKER = 'form-submitted-success';
                var notified = false;
                var pollTimer = null;

                function notify() {
                    if (notified) return;
                    notified = true;
                    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
                    console.log('[TangyCache] Form submitted - closing back to the form list');
                    try { TangyCacheBridge.formSubmitted(); } catch (e) {}
                }

                function check() {
                    if (notified) return;
                    var href = '';
                    try { href = window.location.href || ''; } catch (e) {}
                    if (href.indexOf(SUCCESS_MARKER) !== -1) notify();
                }

                // Angular's HashLocationStrategy changes the URL via
                // history.pushState/replaceState, which does not fire hashchange.
                try {
                    var wrap = function(name) {
                        var orig = window.history[name];
                        if (typeof orig !== 'function') return;
                        window.history[name] = function() {
                            var result = orig.apply(this, arguments);
                            try { check(); } catch (e) {}
                            return result;
                        };
                    };
                    wrap('pushState');
                    wrap('replaceState');
                } catch (e) {}

                try { window.addEventListener('hashchange', check); } catch (e) {}
                try { window.addEventListener('popstate', check); } catch (e) {}

                // The player dispatches 'after-submit' on <tangy-form>. It does not
                // bubble, but a capture-phase listener on document still sees it. It
                // fires before the upload/xAPI work completes, so poll for the success
                // route rather than closing immediately.
                function startPolling() {
                    if (pollTimer || notified) return;
                    var tries = 0;
                    pollTimer = setInterval(function() {
                        check();
                        if (notified || ++tries > 480) {
                            clearInterval(pollTimer);
                            pollTimer = null;
                        }
                    }, 250);
                }
                try { document.addEventListener('after-submit', startPolling, true); } catch (e) {}

                check();
            })();
        """

        /**
         * JavaScript injected into every cached WebView page. When a survey field
         * type (photo / audio / video / location) is denied camera/mic/location
         * access, it shows a short dismissible banner inside the form explaining
         * what is needed, plus an "Open Settings" button when the native bridge
         * is available.
         */
        private const val PERMISSION_HELP_SCRIPT = """
            (function() {
                if (window.__tangyPermissionHelpInjected) return;
                window.__tangyPermissionHelpInjected = true;

                var banners = {
                    media: 'This form needs camera and/or microphone access to answer this question. If Android asks, tap Allow.',
                    camera: 'This form needs camera access to take a photo or video. If Android asks, tap Allow.',
                    mic: 'This form needs microphone access to record audio. If Android asks, tap Allow.',
                    geo: 'This form needs your location to answer this question. If Android asks, tap Allow.'
                };

                function showBanner(text) {
                    try {
                        var old = document.getElementById('tangy-perm-banner');
                        if (old) old.remove();
                        var bar = document.createElement('div');
                        bar.id = 'tangy-perm-banner';
                        bar.textContent = text;
                        bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;padding:12px 16px;' +
                            'background:#212a3f;color:#ffffff;font:600 14px/1.4 Roboto,sans-serif;' +
                            'text-align:center;z-index:2147483647;box-shadow:0 -2px 8px rgba(0,0,0,0.35);';
                        var hasBridge = false;
                        try { hasBridge = !!(window.TangyCacheBridge && TangyCacheBridge.openAppSettings); } catch (e) {}
                        if (hasBridge) {
                            var btn = document.createElement('button');
                            btn.textContent = 'Open Settings';
                            btn.style.cssText = 'display:block;margin:8px auto 0;background:#ffffff;' +
                                'color:#212a3f;border:0;border-radius:4px;padding:6px 14px;' +
                                'font:600 14px Roboto,sans-serif;';
                            btn.onclick = function() { try { TangyCacheBridge.openAppSettings(); } catch (e) {} };
                            bar.appendChild(btn);
                        }
                        bar.addEventListener('click', function() { bar.remove(); });
                        document.body.appendChild(bar);
                        setTimeout(function() { bar.remove(); }, 12000);
                    } catch (e) {}
                }

                // camera / microphone (photo, audio, video field types)
                try {
                    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
                        var origGum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
                        navigator.mediaDevices.getUserMedia = function(constraints) {
                            return origGum(constraints).catch(function(err) {
                                if (err && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError' || err.name === 'SecurityError')) {
                                    var c = constraints || {};
                                    var wantsCam = !!(c.video);
                                    var wantsMic = !!(c.audio);
                                    showBanner(wantsCam && wantsMic ? banners.media : wantsCam ? banners.camera : banners.mic);
                                }
                                throw err;
                            });
                        };
                    }
                } catch (e) {}

                // geolocation (location field types)
                try {
                    if (navigator.geolocation && navigator.geolocation.getCurrentPosition) {
                        var origPos = navigator.geolocation.getCurrentPosition.bind(navigator.geolocation);
                        navigator.geolocation.getCurrentPosition = function(success, error, options) {
                            return origPos(success, function(err) {
                                if (err && (err.code === 1 || err.code === 2)) showBanner(banners.geo);
                                if (typeof error === 'function') error(err);
                            }, options);
                        };
                    }
                } catch (e) {}
            })();
        """

        /**
         * JavaScript injected into every cached WebView page. The online-survey-app
         * submits form responses with XHR/fetch (Angular HttpClient) - not an HTML
         * <form> submit - so FORM_INTERCEPT_SCRIPT never sees them. This wrapper
         * catches POST/PUT requests that fail at the network level (status 0 /
         * onerror, i.e. offline) and re-issues them through TangyCacheBridge.submitForm,
         * which queues them on disk and auto-syncs when connectivity returns.
         * xAPI statements (sent to an LRS /statements endpoint, or relayed over IPC
         * by XAPI_RELAY_SCRIPT) are left untouched.
         */
        private const val XHR_QUEUE_SCRIPT = """
            (function() {
                if (window.__tangyXhrQueueInjected) return;
                window.__tangyXhrQueueInjected = true;
                // When the loaded online-survey-app manages its own offline outbox
                // (offline-outbox.service sets this flag), stand down so submissions
                // are queued exactly once - by the app - and not also here natively.
                try { if (window.__tangerineOutboxActive) return; } catch (e) {}
                var hasBridge = false;
                try { hasBridge = !!(window.TangyCacheBridge && TangyCacheBridge.submitForm); } catch (e) {}
                if (!hasBridge) return;

                function isXapi(url) {
                    return /\/statements(\?|$)/.test(url) || /\/xapi\//.test(url) || /\/tincan\//.test(url);
                }

                function queueSubmission(method, url, body, contentType) {
                    try {
                        var headers = {};
                        if (contentType) headers['Content-Type'] = contentType;
                        console.log('[TangyCache] Queueing offline ' + method + ' ' + url);
                        TangyCacheBridge.submitForm(url, method, (typeof body === 'string') ? body : '', JSON.stringify(headers));
                    } catch (err) {
                        console.warn('[TangyCache] Offline queue submit failed:', err);
                    }
                }

                var origOpen = XMLHttpRequest.prototype.open;
                var origSend = XMLHttpRequest.prototype.send;
                var origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
                XMLHttpRequest.prototype.open = function(method, url) {
                    this.__tangyMethod = (method || 'GET').toUpperCase();
                    this.__tangyUrl = url;
                    this.__tangyContentType = null;
                    return origOpen.apply(this, arguments);
                };
                XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
                    if (String(name).toLowerCase() === 'content-type') {
                        try { this.__tangyContentType = String(value); } catch (e) {}
                    }
                    return origSetHeader.apply(this, arguments);
                };
                XMLHttpRequest.prototype.send = function(body) {
                    var self = this;
                    var method = self.__tangyMethod || 'GET';
                    var url = self.__tangyUrl || '';
                    if (method !== 'GET' && method !== 'HEAD' && !isXapi(url)) {
                        var queued = false;
                        function maybeQueue() {
                            // status 0 == network-level failure (offline / DNS / refused)
                            if (queued || self.status !== 0) return;
                            queued = true;
                            queueSubmission(method, url, body, self.__tangyContentType);
                        }
                        try {
                            self.addEventListener('error', maybeQueue);
                            self.addEventListener('load', maybeQueue);
                        } catch (e) {}
                    }
                    return origSend.apply(this, arguments);
                };

                // Wrap fetch() too (used by some form tooling instead of XHR).
                if (window.fetch) {
                    var origFetch = window.fetch.bind(window);
                    window.fetch = function(input, init) {
                        var url = (typeof input === 'string') ? input : ((input && input.url) || '');
                        var method = (((init && init.method) || (input && input.method) || 'GET') + '').toUpperCase();
                        var promise = origFetch(input, init);
                        if (method === 'GET' || method === 'HEAD' || isXapi(url)) return promise;
                        promise.catch(function() {
                            var headers = (init && init.headers) || {};
                            var contentType = headers['Content-Type'] || headers['content-type'] || null;
                            var body = (init && init.body && typeof init.body === 'string') ? init.body : '';
                            queueSubmission(method, url, body, contentType);
                        });
                        return promise;
                    };
                }
            })();
        """
    }
}
