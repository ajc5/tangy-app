package org.tangerinecentral.tangerine

import android.os.Bundle
import android.util.Log
import androidx.room.Room
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

    private fun startRespectProxy() {
        proxy = LocalCacheProxy(
            cachedHttpClient = cachedHttpClient,
            plainHttpClient = plainHttpClient,
            port = 4242
        )
        proxy!!.start()
        Log.i(TAG, "RESPECT proxy started — all WebView HTTP goes through UstadCache")
    }

    override fun onDestroy() {
        proxy?.stop()
        super.onDestroy()
    }

    companion object {
        const val TAG = "MainActivity"
    }
}
