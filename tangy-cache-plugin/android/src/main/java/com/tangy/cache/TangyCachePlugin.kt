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
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.google.gson.Gson
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import java.io.File
import java.security.MessageDigest
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
    private var proxyServer: CacheProxyServer? = null
    private var connectivityCallback: ConnectivityManager.NetworkCallback? = null

    private val okHttpClient: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .addInterceptor(CacheInterceptor())
            .connectTimeout(30, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .followRedirects(true)
            .followSslRedirects(true)
            .build()
    }

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

    private fun urlToFilename(url: String): String {
        val hash = url.toByteArray(Charsets.UTF_8).let {
            val md = MessageDigest.getInstance("SHA-256")
            md.digest(it).joinToString("") { "%02x".format(it) }
        }
        return hash
    }

    private fun storeOnDisk(url: String, mimeType: String, body: String, headers: Map<String, String>?) {
        val filename = urlToFilename(url)
        File(cacheDir(), filename).writeText(body, Charsets.UTF_8)
        val meta = CacheMeta(
            url = url, mimeType = mimeType,
            headers = headers ?: emptyMap(),
            storedAt = System.currentTimeMillis(),
            sizeBytes = body.toByteArray(Charsets.UTF_8).size.toLong()
        )
        File(metaDir(), "$filename.json").writeText(gson.toJson(meta), Charsets.UTF_8)
    }

    private fun retrieveFromDisk(url: String): Pair<String, CacheMeta>? {
        val filename = urlToFilename(url)
        val file = File(cacheDir(), filename)
        val metaFile = File(metaDir(), "$filename.json")
        if (!file.exists()) return null
        val body = file.readText(Charsets.UTF_8)
        val meta = if (metaFile.exists()) {
            gson.fromJson(metaFile.readText(Charsets.UTF_8), CacheMeta::class.java)
        } else {
            CacheMeta(url, "application/octet-stream", emptyMap(), 0L, 0L)
        }
        return Pair(body, meta)
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
                        val bodyString = networkResponse.body!!.string()
                        val contentType = networkResponse.header("Content-Type")
                            ?: "application/octet-stream"
                        val headers = mutableMapOf<String, String>()
                        networkResponse.headers.names().forEach { name ->
                            networkResponse.headers[name]?.let { headers[name] = it }
                        }
                        storeOnDisk(url, contentType, bodyString, headers)
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
                        rebuilt.body(bodyString.toResponseBody(contentType.toMediaType()))
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
                val fallback = retrieveFromDisk(url)
                if (fallback != null) {
                    val (body, meta) = fallback
                    Log.d(TAG, "CacheInterceptor OFFLINE_FALLBACK $url")
                    Response.Builder()
                        .request(request)
                        .protocol(okhttp3.Protocol.HTTP_1_1)
                        .code(200)
                        .message("OK (offline)")
                        .header("Content-Type", meta.mimeType)
                        .header("X-Cache", "OFFLINE_FALLBACK")
                        .body(body.toResponseBody(meta.mimeType.toMediaType()))
                        .build()
                } else {
                    throw e
                }
            }
        }
    }

    inner class CachingWebViewClient : WebViewClient() {
        override fun onPageFinished(view: WebView?, url: String?) {
            super.onPageFinished(view, url)
            // Inject form interceptor so submissions go through TangyCache's offline queue
            view?.evaluateJavascript(FORM_INTERCEPT_SCRIPT, null)
        }

        override fun shouldInterceptRequest(
            view: WebView?,
            request: WebResourceRequest?
        ): WebResourceResponse? {
            if (request == null || request.method.uppercase() != "GET") return null
            val reqUrl = request.url.toString()
            try {
                val okRequest = Request.Builder().url(reqUrl).apply {
                    request.requestHeaders.entries.forEach {
                        header(it.key, it.value)
                    }
                }.build()

                val response = okHttpClient.newCall(okRequest).execute()
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

        val activity = activity ?: return call.reject("Activity not available")
        activity.runOnUiThread {
            try {
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
                            (rootLayout.parent as? ViewGroup)?.removeView(rootLayout)
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
                            (rootLayout.parent as? ViewGroup)?.removeView(rootLayout)
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
                    settings.allowFileAccess = false
                    settings.cacheMode = android.webkit.WebSettings.LOAD_DEFAULT
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        settings.safeBrowsingEnabled = false
                    }
                    webViewClient = CachingWebViewClient()
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
                call.resolve(JSObject().apply {
                    put("synced", synced)
                    put("failed", failed)
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

    override fun load() {
        super.load()
        registerConnectivitySync()
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
            scope.launch {
                try {
                    val request = Request.Builder().url(url)
                        .method(method, body.toRequestBody(null))
                        .build()
                    val response = okHttpClient.newCall(request).execute()
                    Log.i(TAG, "WebView form submitted: $method $url -> ${response.code}")
                    response.close()
                } catch (e: Exception) {
                    // Offline — queue for later
                    try {
                        val id = UUID.randomUUID().toString()
                        val submission = PendingSubmission(
                            id = id, url = url, method = method,
                            headers = emptyMap(), body = body,
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
    }
}
