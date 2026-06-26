package com.tangy.cache

import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Simple HTTP forward proxy that routes requests through OkHttpClient (with CacheInterceptor).
 * The Capacitor WebView is configured to use this proxy via ProxyController on API 29+.
 */
class CacheProxyServer(
    private val okHttpClient: OkHttpClient,
    private val port: Int = 4242
) {
    private val running = AtomicBoolean(false)
    private var serverSocket: ServerSocket? = null
    private val scope = CoroutineScope(Dispatchers.IO)

    val listeningPort: Int get() = port

    fun start() {
        if (!running.compareAndSet(false, true)) return

        scope.launch {
            try {
                serverSocket = ServerSocket(port, 50, java.net.InetAddress.getByName("127.0.0.1"))
                Log.d(TAG, "CacheProxy started on 127.0.0.1:$port")

                while (running.get()) {
                    try {
                        val client = serverSocket?.accept() ?: break
                        scope.launch { handleClient(client) }
                    } catch (e: Exception) {
                        if (running.get()) Log.w(TAG, "Proxy accept error: ${e.message}")
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Proxy server failed: ${e.message}")
            }
        }
    }

    fun stop() {
        running.set(false)
        try { serverSocket?.close() } catch (_: Exception) {}
    }

    private fun handleClient(client: Socket) {
        try {
            client.use { socket ->
                val reader = BufferedReader(InputStreamReader(socket.getInputStream()))
                val output = socket.getOutputStream()

                // Parse request line: GET /path HTTP/1.1
                val requestLine = reader.readLine() ?: return
                val parts = requestLine.split(" ")
                if (parts.size < 3) return

                val method = parts[0]
                val path = parts[1]

                // Parse headers
                val headers = mutableMapOf<String, String>()
                var host = "localhost"
                var line = reader.readLine()
                while (!line.isNullOrEmpty()) {
                    val colonIdx = line.indexOf(':')
                    if (colonIdx > 0) {
                        val key = line.substring(0, colonIdx).trim()
                        val value = line.substring(colonIdx + 1).trim()
                        headers[key] = value
                        if (key.equals("Host", ignoreCase = true)) host = value
                    }
                    line = reader.readLine()
                }

                // Reconstruct URL
                val scheme = if (path.startsWith("http://") || path.startsWith("https://")) "" else "http://$host"
                val fullUrl = if (path.startsWith("http")) path else "$scheme$path"

                Log.d(TAG, "Proxy $method $fullUrl")

                // Forward through OkHttp (CacheInterceptor handles caching)
                val request = Request.Builder().url(fullUrl).apply {
                    headers.forEach { (key, value) ->
                        if (!key.equals("Proxy-Connection", ignoreCase = true)) {
                            header(key, value)
                        }
                    }
                }.build()

                val response = okHttpClient.newCall(request).execute()
                response.use { resp ->
                    // Write HTTP status line
                    val statusLine = "HTTP/1.1 ${resp.code} ${resp.message}\r\n"
                    output.write(statusLine.toByteArray())

                    // Write headers
                    resp.headers.names().forEach { name ->
                        if (!name.equals("Transfer-Encoding", ignoreCase = true)) {
                            val headerLine = "$name: ${resp.headers[name]}\r\n"
                            output.write(headerLine.toByteArray())
                        }
                    }

                    // Content-Length
                    val bodyBytes = resp.body?.bytes() ?: ByteArray(0)
                    output.write("Content-Length: ${bodyBytes.size}\r\n".toByteArray())
                    output.write("X-Cache-Proxy: ${resp.header("X-Cache", "MISS")}\r\n".toByteArray())
                    output.write("\r\n".toByteArray())

                    // Write body
                    output.write(bodyBytes)
                    output.flush()
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Proxy client error: ${e.message}")
        }
    }

    companion object {
        private const val TAG = "CacheProxy"
    }
}
