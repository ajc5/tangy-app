package com.tangy.cache

import android.util.Log
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
import java.io.File
import java.net.URLEncoder
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * Cache entry metadata stored alongside the cached file.
 */
data class CacheMeta(
    val url: String,
    val mimeType: String,
    val headers: Map<String, String>,
    val storedAt: Long,
    val sizeBytes: Long
)

/**
 * Pin job metadata.
 */
data class PinJob(
    val jobId: String,
    val urls: List<String>,
    val createdAt: Long
)

@CapacitorPlugin(name = "TangyCache")
class TangyCachePlugin : Plugin() {

    private val scope = CoroutineScope(Dispatchers.IO)
    private val gson = Gson()
    private val pinJobs = ConcurrentHashMap<String, PinJob>()

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

    private fun urlToFilename(url: String): String {
        // Simple safe filename from URL using SHA-256 hash prefix
        val hash = url.toByteArray(Charsets.UTF_8).let {
            val md = java.security.MessageDigest.getInstance("SHA-256")
            md.digest(it).joinToString("") { "%02x".format(it) }
        }
        return hash
    }

    private fun storeOnDisk(url: String, mimeType: String, body: String, headers: Map<String, String>?) {
        val filename = urlToFilename(url)
        val file = File(cacheDir(), filename)
        file.writeText(body, Charsets.UTF_8)

        // Write metadata
        val meta = CacheMeta(
            url = url,
            mimeType = mimeType,
            headers = headers ?: emptyMap(),
            storedAt = System.currentTimeMillis(),
            sizeBytes = body.toByteArray(Charsets.UTF_8).size.toLong()
        )
        File(metaDir(), "$filename.json").writeText(gson.toJson(meta), Charsets.UTF_8)
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
                val value = obj.getString(key)
                if (value != null) map[key] = value
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
                val filename = urlToFilename(url)
                val file = File(cacheDir(), filename)
                val metaFile = File(metaDir(), "$filename.json")

                if (!file.exists()) {
                    call.resolve(null)
                    return@launch
                }

                val body = file.readText(Charsets.UTF_8)
                val meta = if (metaFile.exists()) {
                    gson.fromJson(metaFile.readText(Charsets.UTF_8), CacheMeta::class.java)
                } else {
                    CacheMeta(url, "application/octet-stream", emptyMap(), 0L, 0L)
                }

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
        val result = JSObject().apply {
            put("cached", File(cacheDir(), filename).exists())
        }
        call.resolve(result)
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
                    val url = obj.getString("url") ?: continue
                    urlList.add(url)
                }

                val jobId = UUID.randomUUID().toString()
                val pinJob = PinJob(jobId, urlList, System.currentTimeMillis())
                pinJobs[jobId] = pinJob

                // Download and cache each URL
                for (url in urlList) {
                    try {
                        val connection = java.net.URL(url).openConnection() as java.net.HttpURLConnection
                        connection.instanceFollowRedirects = true
                        connection.connectTimeout = 15000
                        connection.readTimeout = 15000
                        connection.requestMethod = "GET"

                        val mimeType = connection.contentType ?: "application/octet-stream"
                        val body = connection.inputStream.bufferedReader(Charsets.UTF_8).readText()
                        val headers = mutableMapOf<String, String>()
                        connection.headerFields?.forEach { (key, values) ->
                            if (key != null && values.isNotEmpty()) {
                                headers[key] = values.first()
                            }
                        }

                        storeOnDisk(url, mimeType, body, headers)
                        connection.disconnect()
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
            try {
                val job = pinJobs.remove(jobId)
                if (job != null) {
                    for (url in job.urls) {
                        val filename = urlToFilename(url)
                        File(cacheDir(), filename).delete()
                        File(metaDir(), "$filename.json").delete()
                    }
                }
                call.resolve()
            } catch (e: Exception) {
                Log.e(TAG, "release error", e)
                call.reject("release failed: ${e.message}")
            }
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
        // Distributed caching (peer-to-peer) is not available in this simplified integration.
        // For full support, clone and include the UstadMobile/Respect repo as a submodule.
        call.resolve()
    }

    override fun handleOnDestroy() {
        super.handleOnDestroy()
    }

    companion object {
        private const val TAG = "TangyCache"
    }
}
