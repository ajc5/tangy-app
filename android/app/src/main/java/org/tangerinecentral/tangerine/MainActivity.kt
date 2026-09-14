package org.tangerinecentral.tangerine

import android.content.Intent
import android.os.Bundle
import android.util.Log
import androidx.room.Room
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.getcapacitor.BridgeActivity
import com.tangy.cache.TangyCachePlugin
import com.ustadmobile.libcache.CachePaths
import com.ustadmobile.libcache.CachePathsProvider
import com.ustadmobile.libcache.UstadCache
import com.ustadmobile.libcache.UstadCacheBuilder
import com.ustadmobile.libcache.connectivitymonitor.ConnectivityMonitorAndroid
import com.ustadmobile.libcache.db.UstadCacheDb
import com.ustadmobile.libcache.okhttp.UstadCacheInterceptor
import kotlinx.io.files.Path
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import org.json.JSONObject
import java.io.File

class MainActivity : BridgeActivity() {

    private var proxy: LocalCacheProxy? = null

    lateinit var ustadCache: UstadCache
    lateinit var cachedHttpClient: OkHttpClient
    lateinit var plainHttpClient: OkHttpClient

    override fun onCreate(savedInstanceState: Bundle?) {
        // Register local TangyCache plugin (not auto-discovered by Capacitor)
        initialPlugins.add(TangyCachePlugin::class.java)
        super.onCreate(savedInstanceState)

        // The shell header is always dark navy (#212a3f) and, on Android 15+
        // (targetSdk 35+), the app draws edge-to-edge so that header sits behind
        // the status bar. The clock and battery must therefore be white: with the
        // default light-status-bar appearance they render near-black
        // (measured #0d1119) on navy, i.e. invisible.
        //
        // This has to run AFTER super.onCreate(): the activity theme's
        // light-status-bar appearance is applied during activity creation and
        // beats the values/styles.xml declaration, so a runtime override is the
        // only reliable place.
        applyStatusBarIconAppearance()

        // 1. Build the Room database for cache metadata
        val cacheDb = Room.databaseBuilder(
            applicationContext,
            UstadCacheDb::class.java,
            UstadCacheBuilder.DEFAULT_DB_NAME
        ).build()

        // 2. Build the UstadCache (Respect librespect cache)
        val cachePathsProvider = CachePathsProvider {
            CachePaths(
                tmpWorkPath = Path(File(cacheDir, "ustad-tmpwork").absolutePath),
                persistentPath = Path(File(filesDir, "ustad-persistent").absolutePath),
                cachePath = Path(File(cacheDir, "ustad-cache").absolutePath),
            )
        }

        ustadCache = UstadCacheBuilder(
            appContext = applicationContext,
            storagePath = Path(File(filesDir, "httpfiles").absolutePath),
            sizeLimit = { 100_000_000L },
            db = cacheDb,
            cachePathsProvider = cachePathsProvider,
        ).build()

        // 3a. Cached OkHttpClient for GET requests (UstadCacheInterceptor)
        cachedHttpClient = OkHttpClient.Builder()
            .connectTimeout(30, java.util.concurrent.TimeUnit.SECONDS)
            .readTimeout(30, java.util.concurrent.TimeUnit.SECONDS)
            .writeTimeout(30, java.util.concurrent.TimeUnit.SECONDS)
            .addInterceptor(
                UstadCacheInterceptor(
                    cache = ustadCache,
                    tmpDirProvider = { File(cacheDir, "ustad-tmp") },
                    json = Json { ignoreUnknownKeys = true },
                    connectivityMonitor = ConnectivityMonitorAndroid(this),
                )
            )
            .build()

        // 3b. Plain OkHttpClient for POST/PUT/DELETE (no caching)
        plainHttpClient = OkHttpClient.Builder()
            .connectTimeout(30, java.util.concurrent.TimeUnit.SECONDS)
            .readTimeout(30, java.util.concurrent.TimeUnit.SECONDS)
            .writeTimeout(30, java.util.concurrent.TimeUnit.SECONDS)
            .build()

        // 4. Start the local RESPECT cache proxy on port 4242
        startRespectProxy()
    }

    /**
     * Force white status-bar icons to match the always-dark shell header.
     *
     * NOTE: at onCreate/onResume the window usually has no real insets
     * controller yet - it reports `PendingInsetsController` with
     * `decorAttached=false`, so the flag is accepted but never reaches the
     * display (verified in logcat). The value therefore has to be (re)asserted
     * once the decor view is genuinely attached, which is why onResume posts it
     * and also hooks the inset dispatch.
     */
    private fun applyStatusBarIconAppearance() {
        WindowInsetsControllerCompat(window, window.decorView)
            .isAppearanceLightStatusBars = false
    }

    override fun onResume() {
        super.onResume()
        // Runs after attach, so the controller is real rather than pending.
        window.decorView.post { applyStatusBarIconAppearance() }
        // Belt and braces: re-assert on every inset dispatch (rotation, system
        // bar changes, returning to the app).
        ViewCompat.setOnApplyWindowInsetsListener(window.decorView) { _, insets ->
            applyStatusBarIconAppearance()
            insets
        }
    }

    private fun startRespectProxy() {
        proxy = LocalCacheProxy(
            cachedHttpClient = cachedHttpClient,
            plainHttpClient = plainHttpClient,
            port = 4242
        )
        proxy!!.start()
        Log.i(TAG, "RESPECT proxy started — all WebView HTTP goes through UstadCache")
    }

    /**
     * Handle the Open Educational Experience Launcher (RESPECT)
     * org.openeel.action.LAUNCH intent. RESPECT fires this action with the lesson
     * URL as the intent data when it detects this app is installed and the lesson
     * host is not a verified App Link (e.g. the user can connect to any Tangerine
     * server).
     *
     * Cold starts are already handled by Capacitor's App.getLaunchUrl() (the
     * bridge captures the intent data regardless of action), so this only needs to
     * forward the URL on warm starts, where Capacitor's appUrlOpen event is
     * limited to ACTION_VIEW intents.
     */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (intent.action == OPEN_EEL_LAUNCH_ACTION) {
            val url = intent.data?.toString()
            if (url != null) {
                Log.i(TAG, "OpenEel LAUNCH intent received: $url")
                forwardDeepLinkToJs(url)
            }
        }
    }

    private fun forwardDeepLinkToJs(url: String) {
        val webView = bridge?.webView ?: return
        webView.post {
            // JSONObject.quote produces a properly escaped JS string literal.
            val js = "window.handleDeepLink ? handleDeepLink(${JSONObject.quote(url)}) : null;"
            Log.i(TAG, "Forwarding deep link to JS: $js")
            webView.evaluateJavascript(js, null)
        }
    }

    override fun onDestroy() {
        proxy?.stop()
        super.onDestroy()
    }

    companion object {
        const val TAG = "MainActivity"
        const val OPEN_EEL_LAUNCH_ACTION = "org.openeel.action.LAUNCH"
    }
}
