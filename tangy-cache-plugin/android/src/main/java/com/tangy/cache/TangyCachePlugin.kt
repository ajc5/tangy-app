package com.tangy.cache

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Build
import android.util.Log
import android.view.ViewGroup
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.LinearLayout
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
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import world.respect.lib.dataloadstate.DataReadyState
import world.respect.lib.xapi.model.XapiStatement
import world.respect.xapi.ipc.client.XapiIpcClientBuilder
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

data class PendingXapi(
    val id: String,
    val endpoint: String,
    val auth: String,
    val ipcPackage: String,
    val statementsJson: String,
    val createdAt: Long
)

@CapacitorPlugin(name = "TangyCache")
class TangyCachePlugin : Plugin() {

    private val gson = Gson()
    private val scope = CoroutineScope(Dispatchers.IO)
    private val pinJobs = ConcurrentHashMap<String, PinJob>()

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

    // Directory for xAPI statement batches that could not be delivered to the
    // RESPECT launcher (IPC unreachable / offline) at submit time. Replayed when
    // connectivity returns.
    private fun xapiPendingDir(): File {
        val dir = File(activity?.filesDir, "tangy-pending-xapi")
        if (!dir.exists()) dir.mkdirs()
        return dir
    }

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

            // Truly offline (no active network at all — airplane mode / radios
            // off): don't attempt a connection. Serving straight from disk
            // avoids the DNS/connect stalls that make the FIRST offline load of
            // a cached page take 20-30s (or hang) before falling back to cache.
            // When ANY network is present we stay network-first below so API and
            // feed data never goes stale.
            if (!hasActiveNetwork()) {
                Log.d(TAG, "CacheInterceptor OFFLINE_FASTPATH $url — no active network")
                serveFromDiskOrRespect(request)?.let { return it }
                throw IOException("Offline (no active network) and not cached: $url")
            }

            // Network-first: always try the network when online so we get
            // FRESH data (group/form lists, OPDS feeds, form HTML). The disk
            // cache is used as an OFFLINE fallback (and for manual pins).
            // This prevents stale responses — e.g. a group that no longer
            // exists, or an empty form list — from being served forever.
            Log.d(TAG, "CacheInterceptor FETCH $url — trying network")
            return try {
                val networkResponse = chain.proceed(request)

                if (networkResponse.isSuccessful && networkResponse.body != null) {
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
                            .request(request)
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
                serveFromDiskOrRespect(request) ?: throw e
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
        override fun onPageFinished(view: WebView?, url: String?) {
            super.onPageFinished(view, url)
            // Inject the form interceptor (offline submissions) plus the
            // permission-help banner (camera/mic/location denial messaging)
            // and the xAPI relay (RESPECT launcher IPC handoff).
            view?.evaluateJavascript(FORM_INTERCEPT_SCRIPT, null)
            view?.evaluateJavascript(PERMISSION_HELP_SCRIPT, null)
            view?.evaluateJavascript(XAPI_RELAY_SCRIPT, null)
            view?.evaluateJavascript(XHR_QUEUE_SCRIPT, null)
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

    /** Release any pending permission/file-chooser state, then remove the WebView. */
    private fun closeCachedWebView(rootLayout: ViewGroup) {
        completeFileChooser(null)
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
                    // Back button (left end)
                    val backBtn = TextView(activity).apply {
                        text = "\u2190"
                        setTextColor(Color.WHITE)
                        textSize = 20f
                        setPadding(12, 8, 12, 8)
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
                    // Close button (right end)
                    val closeBtn = TextView(activity).apply {
                        text = "X"
                        setTextColor(Color.WHITE)
                        textSize = 18f
                        setPadding(12, 8, 12, 8)
                        setOnClickListener {
                            closeCachedWebView(rootLayout)
                        }
                    }
                    toolbar.addView(closeBtn)
                    rootLayout.addView(toolbar)
                }

                val webView = WebView(activity).apply {
                    layoutParams = LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.MATCH_PARENT,
                        0, 1f
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
                rootLayout.addView(webView)
                activity.addContentView(
                    rootLayout,
                    ViewGroup.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT
                    )
                )

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
        val count = pendingDir().listFiles()?.count { it.name.endsWith(".json") } ?: 0
        call.resolve(JSObject().apply { put("count", count) })
    }

    @PluginMethod
    fun syncPending(call: PluginCall) {
        scope.launch {
            try {
                val files = pendingDir().listFiles()?.filter { it.name.endsWith(".json") }
                    ?: emptyList()
                var synced = 0
                var failed = 0
                for (file in files) {
                    try {
                        val submission = gson.fromJson(file.readText(Charsets.UTF_8), PendingSubmission::class.java)
                        val request = Request.Builder().url(submission.url)
                            .method(submission.method, submission.body.toRequestBody(null))
                            .apply {
                                submission.headers.forEach { (k, v) -> addHeader(k, v) }
                            }
                            .build()
                        val response = okHttpClient.newCall(request).execute()
                        if (response.isSuccessful) synced++ else failed++
                        response.close()
                        file.delete()
                    } catch (e: Exception) {
                        failed++
                        Log.w(TAG, "Sync failed for ${file.name}: ${e.message}")
                    }
                }
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
                })
            } catch (e: Exception) {
                call.reject("Sync failed: ${e.message}")
            }
        }
    }

    @PluginMethod
    fun clearPending(call: PluginCall) {
        pendingDir().listFiles()?.forEach { it.delete() }
        call.resolve()
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
     * Persist a batch of xAPI statements that could not be delivered now, so they
     * are replayed (to the same launcher IPC target) once connectivity returns.
     */
    private fun queueXapiPending(endpoint: String, auth: String, ipcPackage: String, statementsJson: String) {
        try {
            val dir = xapiPendingDir()
            val id = UUID.randomUUID().toString()
            val item = PendingXapi(id, endpoint, auth, ipcPackage, statementsJson, System.currentTimeMillis())
            File(dir, "$id.json").writeText(gson.toJson(item), Charsets.UTF_8)
            Log.i(TAG, "Queued $id xAPI statements for offline delivery (launcher $ipcPackage unreachable)")
        } catch (e: Exception) {
            Log.e(TAG, "Could not queue xAPI statements for offline delivery", e)
        }
    }

    /** Blocking (suspend) delivery of one xAPI batch to the launcher over IPC. */
    private suspend fun deliverXapiNow(endpoint: String, auth: String, ipcPackage: String, statementsJson: String): Boolean {
        val ctx = activity?.applicationContext ?: return false
        return try {
            val json = Json { ignoreUnknownKeys = true }
            val statements = json.decodeFromString(
                ListSerializer(XapiStatement.serializer()), statementsJson
            )
            val client = XapiIpcClientBuilder(ctx, endpoint)
                .setAuth(auth)
                .setJson(json)
                .setIpcServicePackageName(ipcPackage)
                .build()
            try {
                val result = client.statements.post(statements)
                val ok = result is DataReadyState
                Log.i(TAG, "Delivered ${statements.size} xAPI statements to $ipcPackage (ok=$ok): $result")
                ok
            } finally {
                try { client.close() } catch (_: Throwable) { /* ignore */ }
            }
        } catch (e: Exception) {
            Log.e(TAG, "deliverXapiNow failed", e)
            false
        }
    }

    /** Replay every queued xAPI batch; returns how many were delivered. */
    private suspend fun replayQueuedXapi(): Int {
        val files = xapiPendingDir().listFiles()?.filter { it.name.endsWith(".json") } ?: emptyList()
        var sent = 0
        for (file in files) {
            try {
                val item = gson.fromJson(file.readText(Charsets.UTF_8), PendingXapi::class.java)
                if (deliverXapiNow(item.endpoint, item.auth, item.ipcPackage, item.statementsJson)) {
                    file.delete()
                    sent++
                }
            } catch (e: Exception) {
                Log.w(TAG, "xAPI replay failed for ${file.name}: ${e.message}")
            }
        }
        return sent
    }

    /**
     * Shared relay used by both the Capacitor @PluginMethod and the WebView TangyCacheBridge.
     * Runs off the main thread; onResult is invoked on the plugin's IO scope.
     * Offline persistence is handled by the online-survey-app's own outbox when present
     * (it sets window.__tangerineOutboxActive), so by default we do NOT also queue here
     * (avoids double delivery). queueOnFailure can re-enable it for hosts without the outbox.
     */
    private fun forwardStatementsViaIpc(
        endpoint: String,
        auth: String,
        ipcPackage: String,
        statementsJson: String,
        queueOnFailure: Boolean = false,
        onResult: ((ok: Boolean, count: Int, result: String) -> Unit)? = null
    ) {
        val ctx = activity?.applicationContext
        if (ctx == null) {
            Log.e(TAG, "forwardXapiStatements failed: activity not available")
            onResult?.invoke(false, 0, "Activity not available")
            return
        }
        scope.launch {
            val ok = deliverXapiNow(endpoint, auth, ipcPackage, statementsJson)
            if (!ok && queueOnFailure) {
                queueXapiPending(endpoint, auth, ipcPackage, statementsJson)
            }
            onResult?.invoke(ok, 0, if (ok) "delivered" else "failed")
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
                        val files = pendingDir().listFiles()?.filter { it.name.endsWith(".json") } ?: emptyList()
                        for (file in files) {
                            try {
                                val submission = gson.fromJson(
                                    file.readText(Charsets.UTF_8),
                                    PendingSubmission::class.java
                                )
                                val request = Request.Builder().url(submission.url)
                                    .method(submission.method, submission.body.toRequestBody(null))
                                    .apply {
                                        submission.headers.forEach { (k, v) -> addHeader(k, v) }
                                    }
                                    .build()
                                val response = okHttpClient.newCall(request).execute()
                                if (response.isSuccessful) file.delete()
                                response.close()
                            } catch (e: Exception) {
                                Log.w(TAG, "Auto-sync failed for ${file.name}: ${e.message}")
                            }
                        }
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
            return pendingDir.listFiles()?.count { it.name.endsWith(".json") } ?: 0
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
    }

    companion object {
        private const val TAG = "TangyCache"

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
