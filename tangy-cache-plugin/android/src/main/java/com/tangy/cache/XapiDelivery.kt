package com.tangy.cache

import android.content.Context
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.google.gson.Gson
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import world.respect.lib.dataloadstate.DataReadyState
import world.respect.lib.xapi.model.XapiStatement
import world.respect.xapi.ipc.client.XapiIpcClientBuilder
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/**
 * One xAPI statement batch waiting to be relayed to the RESPECT launcher.
 *
 * Persisted as a JSON file under [XapiDelivery.PENDING_DIR] so a batch survives the
 * app being killed, and so WorkManager can deliver it later.
 */
data class PendingXapi(
    val id: String,
    val endpoint: String,
    val auth: String,
    val ipcPackage: String,
    val statementsJson: String,
    val createdAt: Long
)

/**
 * Durable outbox for xAPI statement batches bound for the RESPECT launcher's
 * xAPI-over-IPC service.
 *
 * Delivery is a two-hop journey: this app hands statements to the launcher over IPC
 * (a local Binder call, always possible), and the *launcher* posts them to the school
 * LRS (needs connectivity). So a batch can be undeliverable for two quite different
 * reasons, and neither is under the lesson WebView's control - which is why the batch
 * is persisted here first and retried by [XapiDeliveryWorker] rather than being left
 * in the form player's localStorage outbox:
 *
 *  * the work is registered with a [NetworkType.CONNECTED] constraint, so a device
 *    that is offline when the form is submitted gets the batch delivered as soon as
 *    connectivity returns;
 *  * WorkManager persists the work in its own database, so that happens even if the
 *    app is killed (or the device reboots) before the network comes back.
 *
 * Batches are content-addressed: queueing the same statements twice is a no-op, and a
 * file is deleted only once the launcher confirms delivery with a DataReadyState.
 */
object XapiDelivery {

    private const val TAG = "TangyCache"

    const val PENDING_DIR = "tangy-pending-xapi"
    const val WORK_NAME = "tangy-xapi-delivery"
    const val WORK_TAG = "xapi-delivery"

    /**
     * Give up after this many attempts *for now* - the batch is kept on disk and the
     * job is re-armed on the next app start, so a launcher that is merely uninstalled
     * or an LRS that is down does not spin forever.
     */
    private const val MAX_ATTEMPTS = 12

    private val gson = Gson()
    private val json = Json { ignoreUnknownKeys = true }

    // Serialises delivery: the WorkManager worker and the connectivity callback's
    // fast-path replay would otherwise race and deliver the same batch twice.
    private val deliveryMutex = Mutex()

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    private fun dir(ctx: Context): File =
        File(ctx.filesDir, PENDING_DIR).apply { if (!exists()) mkdirs() }

    /** Directory holding the not-yet-delivered batches. */
    fun pendingDir(ctx: Context): File = dir(ctx)

    fun pendingCount(ctx: Context): Int =
        dir(ctx).listFiles()?.count { it.name.endsWith(".json") } ?: 0

    /**
     * Content-addressed id: the same batch (same statements, same launcher, same
     * endpoint) always maps to the same file, so a caller that retries cannot create
     * a duplicate.
     */
    private fun batchId(
        endpoint: String,
        auth: String,
        ipcPackage: String,
        statementsJson: String
    ): String {
        val canonical = "$endpoint\u0000$auth\u0000$ipcPackage\u0000$statementsJson"
        val digest = MessageDigest.getInstance("SHA-256")
            .digest(canonical.toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { "%02x".format(it) }
    }

    /**
     * Persist a batch and arm the delivery job. Synchronous on purpose: the lesson
     * WebView relies on the return value before dropping its own copy, so "true" must
     * mean the batch is already on disk (written now, or queued by an earlier attempt).
     *
     * Unless [attemptNow] is false (the caller has just tried), the IPC hop is attempted
     * immediately *even with no network*: handing statements to the launcher is a local
     * Binder call, so being offline is no reason to skip it - only the launcher's onward
     * POST to the LRS needs connectivity, and that is what the WorkManager job is for.
     */
    fun accept(
        ctx: Context,
        endpoint: String,
        auth: String,
        ipcPackage: String,
        statementsJson: String,
        attemptNow: Boolean = true
    ): Boolean {
        return try {
            val id = batchId(endpoint, auth, ipcPackage, statementsJson)
            val file = File(dir(ctx), "$id.json")
            if (!file.exists()) {
                val item = PendingXapi(
                    id = id,
                    endpoint = endpoint,
                    auth = auth,
                    ipcPackage = ipcPackage,
                    statementsJson = statementsJson,
                    createdAt = System.currentTimeMillis()
                )
                file.writeText(gson.toJson(item), Charsets.UTF_8)
                Log.i(
                    TAG,
                    "Queued xAPI batch ${id.take(8)} for delivery via $ipcPackage " +
                        "(WorkManager, connectivity-gated)"
                )
            }
            enqueue(ctx)
            if (attemptNow) {
                scope.launch { deliverPending(ctx) }
            }
            true
        } catch (e: Exception) {
            Log.e(TAG, "Could not persist xAPI batch", e)
            false
        }
    }

    /** Arm (or keep) the connectivity-gated delivery job. */
    fun enqueue(ctx: Context) {
        try {
            val constraints = Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()
            val request = OneTimeWorkRequestBuilder<XapiDeliveryWorker>()
                .setConstraints(constraints)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .addTag(WORK_TAG)
                .build()
            WorkManager.getInstance(ctx)
                .enqueueUniqueWork(WORK_NAME, ExistingWorkPolicy.KEEP, request)
        } catch (e: Exception) {
            // Delivery still gets a chance from the connectivity callback / next start.
            Log.w(TAG, "Could not enqueue xAPI delivery job: ${e.message}")
        }
    }

    /** Arm the job only when there is something to deliver (used at plugin load). */
    fun enqueueIfPending(ctx: Context) {
        if (pendingCount(ctx) > 0) enqueue(ctx)
    }

    /**
     * Relay one batch to the launcher over IPC. Returns true only when the launcher
     * reported the statements as delivered (DataReadyState); the caller keeps the
     * batch otherwise.
     */
    suspend fun deliver(ctx: Context, item: PendingXapi): Boolean {
        return try {
            val statements = json.decodeFromString(
                ListSerializer(XapiStatement.serializer()), item.statementsJson
            )
            val client = XapiIpcClientBuilder(ctx, item.endpoint)
                .setAuth(item.auth)
                .setJson(json)
                .setIpcServicePackageName(item.ipcPackage)
                .build()
            try {
                val result = client.statements.post(statements)
                val ok = result is DataReadyState
                Log.i(
                    TAG,
                    "Delivered ${statements.size} xAPI statements to ${item.ipcPackage} (ok=$ok): $result"
                )
                ok
            } finally {
                try { client.close() } catch (_: Throwable) { /* ignore */ }
            }
        } catch (e: Exception) {
            Log.w(TAG, "xAPI IPC delivery failed (${e.javaClass.simpleName}: ${e.message})")
            false
        }
    }

    /**
     * Deliver every queued batch, deleting each one only after the launcher confirms
     * it. Returns the number of batches delivered by this call.
     */
    suspend fun deliverPending(ctx: Context): Int = deliveryMutex.withLock {
        val files = dir(ctx).listFiles()?.filter { it.name.endsWith(".json") } ?: emptyList()
        var delivered = 0
        for (file in files) {
            try {
                val item = gson.fromJson(file.readText(Charsets.UTF_8), PendingXapi::class.java)
                if (item == null || item.endpoint.isBlank() || item.ipcPackage.isBlank()) {
                    // Unreadable / malformed: drop it rather than block the queue forever.
                    Log.w(TAG, "Discarding unusable queued xAPI batch ${file.name}")
                    file.delete()
                    continue
                }
                if (deliver(ctx, item)) {
                    file.delete()
                    delivered++
                }
            } catch (e: Exception) {
                Log.w(TAG, "xAPI delivery attempt failed for ${file.name}: ${e.message}")
            }
        }
        delivered
    }

    /** WorkManager worker: run the queue once the device reports a network. */
    class XapiDeliveryWorker(
        appContext: Context,
        params: WorkerParameters
    ) : CoroutineWorker(appContext, params) {

        override suspend fun doWork(): Result {
            val ctx = applicationContext
            val delivered = XapiDelivery.deliverPending(ctx)
            val remaining = XapiDelivery.pendingCount(ctx)
            return when {
                remaining == 0 -> {
                    Log.i(TAG, "xAPI delivery queue drained ($delivered batch(es) delivered)")
                    Result.success()
                }
                // Keep the batch on disk; the job is re-armed on the next app start.
                runAttemptCount >= MAX_ATTEMPTS -> {
                    Log.w(
                        TAG,
                        "xAPI delivery giving up after $runAttemptCount attempts; " +
                            "$remaining batch(es) kept for the next app start"
                    )
                    Result.failure()
                }
                else -> {
                    Log.i(
                        TAG,
                        "xAPI delivery incomplete; $remaining batch(es) pending, will retry"
                    )
                    Result.retry()
                }
            }
        }
    }
}
