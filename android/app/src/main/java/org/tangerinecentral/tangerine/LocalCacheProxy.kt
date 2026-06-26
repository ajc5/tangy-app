package org.tangerinecentral.tangerine

import android.util.Log
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.util.concurrent.Executors

/**
 * Local HTTP proxy that routes all requests through OkHttpClient with UstadCacheInterceptor.
 * This mirrors the RESPECT pattern: LibRespectProxyServer(libRespectCache).start()
 *
 * The Capacitor WebView and JS fetch() calls route through this proxy,
 * so ALL HTTP responses are cached for offline use.
 */
class LocalCacheProxy(
    private val cachedHttpClient: OkHttpClient,
    private val plainHttpClient: OkHttpClient,
    private val port: Int = DEFAULT_PORT
) {
    private var serverSocket: ServerSocket? = null
    private val executor = Executors.newCachedThreadPool()
    @Volatile var isRunning: Boolean = false
        private set

    fun start() {
        if (isRunning) return
        serverSocket = ServerSocket()
        serverSocket!!.reuseAddress = true
        serverSocket!!.bind(InetSocketAddress("127.0.0.1", port))
        isRunning = true
        Log.i(TAG, "RESPECT cache proxy started on port $port")

        executor.submit {
            while (isRunning) {
                try {
                    val client = serverSocket!!.accept()
                    executor.submit { handleClient(client) }
                } catch (e: Exception) {
                    if (isRunning) Log.e(TAG, "Proxy accept error", e)
                }
            }
        }
    }

    fun stop() {
        isRunning = false
        try { serverSocket?.close() } catch (_: Exception) {}
        executor.shutdownNow()
        Log.i(TAG, "RESPECT cache proxy stopped")
    }

    private fun handleClient(socket: java.net.Socket) {
        try {
            socket.use { s ->
                val input = s.getInputStream()
                val output: OutputStream = s.getOutputStream()

                // Read the HTTP request line
                val reader = input.bufferedReader()
                val requestLine = reader.readLine() ?: return
                val parts = requestLine.split(" ")
                if (parts.size < 3) return
                val method = parts[0]
                val path = parts[1]

                Log.d(TAG, "Received: $method $path")

                // Read headers
                val headers = mutableMapOf<String, String>()
                var line = reader.readLine()
                while (!line.isNullOrEmpty()) {
                    val colonIdx = line.indexOf(':')
                    if (colonIdx > 0) {
                        val key = line.substring(0, colonIdx).trim().lowercase()
                        val value = line.substring(colonIdx + 1).trim()
                        headers[key] = value
                    }
                    line = reader.readLine()
                }

                // CORS preflight — respond with permissive headers so the WebView allows cross-origin requests
                if (method.equals("OPTIONS", true)) {
                    val corsResponse = buildString {
                        append("HTTP/1.1 204 No Content\r\n")
                        append("Access-Control-Allow-Origin: *\r\n")
                        append("Access-Control-Allow-Methods: GET, POST, PUT, DELETE, PATCH, OPTIONS\r\n")
                        append("Access-Control-Allow-Headers: *\r\n")
                        append("Access-Control-Max-Age: 86400\r\n")
                        append("Content-Length: 0\r\n")
                        append("\r\n")
                    }
                    output.write(corsResponse.toByteArray(Charsets.UTF_8))
                    output.flush()
                    return
                }

                // Health check — respond immediately
                if (path == "/health") {
                    Log.d(TAG, "Health check OK")
                    val body = "ok"
                    val bodyBytes = body.toByteArray(Charsets.UTF_8)
                    val response = buildString {
                        append("HTTP/1.1 200 OK\r\n")
                        append("Content-Type: text/plain\r\n")
                        append("Content-Length: ${bodyBytes.size}\r\n")
                        append("Connection: close\r\n")
                        append("Access-Control-Allow-Origin: *\r\n")
                        append("\r\n")
                    }
                    output.write(response.toByteArray(Charsets.UTF_8))
                    output.write(bodyBytes)
                    output.flush()
                    return
                }

                // Determine the target URL
                val hostHeader = headers["host"]
                val targetUrl = if (path.startsWith("/http://") || path.startsWith("/https://")) {
                    path.substring(1) // Strip leading / for absolute proxy URLs
                } else if (path.startsWith("http://") || path.startsWith("https://")) {
                    path
                } else if (hostHeader != null) {
                    "http://$hostHeader$path"
                } else {
                    sendResponse(output, 400, "Bad Request", "bad request")
                    return
                }

                Log.d(TAG, "Proxy: $method $targetUrl")

                // Read request body for POST/PUT/PATCH
                val contentLength = headers["content-length"]?.toIntOrNull() ?: 0
                val requestBody = if (contentLength > 0) {
                    val body = ByteArray(contentLength)
                    var read = 0
                    while (read < contentLength) {
                        val n = input.read(body, read, contentLength - read)
                        if (n < 0) break
                        read += n
                    }
                    body
                } else {
                    ByteArray(0)
                }

                // Forward through OkHttp (which has UstadCacheInterceptor)
                val okRequestBody = if (requestBody.isNotEmpty()) {
                    headers["content-type"]?.toMediaTypeOrNull()?.let { mt ->
                        requestBody.toRequestBody(mt)
                    } ?: requestBody.toRequestBody(null)
                } else if (method.equals("POST", true) || method.equals("PUT", true) || method.equals("PATCH", true)) {
                    ByteArray(0).toRequestBody(null)
                } else {
                    null
                }

                val requestBuilder = Request.Builder().url(targetUrl)
                    .method(method, okRequestBody)
                headers.forEach { (key, value) ->
                    if (key != "host" && key != "connection" && key != "proxy-connection") {
                        requestBuilder.addHeader(key, value)
                    }
                }

                try {
                    val client = if (method.equals("GET", true) || method.equals("HEAD", true)) {
                        cachedHttpClient
                    } else {
                        plainHttpClient
                    }
                    val response = client.newCall(requestBuilder.build()).execute()
                    Log.d(TAG, "Response: ${response.code} for $method $targetUrl")

                    val statusLine = "HTTP/1.1 ${response.code} ${response.message}\r\n"
                    output.write(statusLine.toByteArray())
                    output.write("Access-Control-Allow-Origin: *\r\n".toByteArray())
                    response.headers.forEach { (name, value) ->
                        output.write("$name: $value\r\n".toByteArray())
                    }
                    output.write("\r\n".toByteArray())
                    response.body?.byteStream()?.use { it.copyTo(output) }
                    output.flush()
                    response.close()
                } catch (e: Exception) {
                    Log.e(TAG, "Upstream error for $targetUrl: ${e.message}", e)
                    val errBody = "upstream error: ${e.message}"
                    val errBodyBytes = errBody.toByteArray(Charsets.UTF_8)
                    val errResp = buildString {
                        append("HTTP/1.1 502 Bad Gateway\r\n")
                        append("Content-Type: text/plain\r\n")
                        append("Content-Length: ${errBodyBytes.size}\r\n")
                        append("Access-Control-Allow-Origin: *\r\n")
                        append("\r\n")
                    }
                    output.write(errResp.toByteArray(Charsets.UTF_8))
                    output.write(errBodyBytes)
                    output.flush()
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Proxy client error", e)
        }
    }

    private fun sendResponse(output: OutputStream, code: Int, message: String, body: String) {
        val response = """
            HTTP/1.1 $code $message
            Content-Type: text/plain
            Content-Length: ${body.length}
            Connection: close

            $body
        """.trimIndent().replace("\n", "\r\n") + "\r\n"
        output.write(response.toByteArray())
        output.flush()
    }

    companion object {
        const val DEFAULT_PORT = 4242
        const val TAG = "LocalCacheProxy"
    }
}
