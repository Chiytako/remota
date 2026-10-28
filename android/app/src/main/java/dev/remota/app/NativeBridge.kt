package dev.remota.app

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap

/**
 * What the web UI (window.RemotaNative) can ask of the app. All traffic to machines goes through
 * here so it uses the pinned HTTPS clients; results come back by calling window.RemotaBridge.*.
 */
class NativeBridge(private val activity: MainActivity, private val web: WebView) {
    private val sockets = ConcurrentHashMap<String, WebSocket>()

    /** Calls RemotaBridge.<fn>(args…) in the page; every argument is passed as a JSON value. */
    fun emit(fn: String, vararg args: Any?) {
        val js = args.joinToString(",") { a ->
            when (a) {
                null -> "null"
                is Number, is Boolean -> a.toString()
                is JSONObject -> a.toString()
                else -> JSONObject.quote(a.toString())
            }
        }
        activity.runOnUiThread {
            web.evaluateJavascript("window.RemotaBridge && window.RemotaBridge.$fn($js)", null)
        }
    }

    @JavascriptInterface
    fun request(id: String, deviceJson: String, method: String, path: String, headersJson: String, bodyB64: String?) {
        try {
            val dev = Device.fromJson(deviceJson)
            val headers = JSONObject(headersJson)
            val type = headers.optString("Content-Type", "application/octet-stream").toMediaTypeOrNull()
            val body = when {
                bodyB64 != null -> Base64.decode(bodyB64, Base64.NO_WRAP).toRequestBody(type)
                method == "POST" || method == "PATCH" || method == "PUT" -> ByteArray(0).toRequestBody(type)
                else -> null
            }
            val req = Request.Builder().url(dev.url + path).method(method, body).apply {
                headers.keys().forEach { k -> header(k, headers.getString(k)) }
                header("Authorization", "Bearer ${dev.token}")
            }.build()
            DeviceNetwork.client(dev.pin).newCall(req).enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) = emit("onResponse", id, 0, "", null, DeviceNetwork.describe(e))
                override fun onResponse(call: Call, response: Response) {
                    response.use {
                        val bytes = it.body?.bytes() ?: ByteArray(0)
                        emit("onResponse", id, it.code, it.header("Content-Type") ?: "", Base64.encodeToString(bytes, Base64.NO_WRAP), null)
                    }
                }
            })
        } catch (e: Exception) {
            emit("onResponse", id, 0, "", null, e.message ?: "request failed")
        }
    }

    @JavascriptInterface
    fun wsOpen(id: String, deviceJson: String, pathAndQuery: String) {
        try {
            val dev = Device.fromJson(deviceJson)
            val req = Request.Builder().url(dev.url + pathAndQuery).header("Authorization", "Bearer ${dev.token}").build()
            sockets[id] = DeviceNetwork.client(dev.pin).newWebSocket(req, object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) = emit("onWs", id, "open", null)
                override fun onMessage(webSocket: WebSocket, text: String) = emit("onWs", id, "message", text)
                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(code, null)
                }
                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    sockets.remove(id)
                    emit("onWs", id, "close", code)
                }
                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    sockets.remove(id)
                    emit("onWs", id, "error", DeviceNetwork.describe(t))
                    emit("onWs", id, "close", response?.code ?: 1006)
                }
            })
        } catch (e: Exception) {
            emit("onWs", id, "error", e.message ?: "websocket failed")
            emit("onWs", id, "close", 1006)
        }
    }

    @JavascriptInterface
    fun wsSend(id: String, text: String): Boolean = sockets[id]?.send(text) ?: false

    @JavascriptInterface
    fun wsClose(id: String) {
        sockets.remove(id)?.close(1000, null)
    }

    // ----- push (UnifiedPush) -----

    @JavascriptInterface
    fun pushStatus(): String = Push.status(activity).toString()

    @JavascriptInterface
    fun pushEnable() = activity.runOnUiThread { activity.enablePush() }

    @JavascriptInterface
    fun pushDisable() = activity.runOnUiThread { Push.disable(activity) }

    /** Names the phone uses for its machines, so notifications can say which machine they're from. */
    @JavascriptInterface
    fun setDeviceNames(json: String) {
        activity.getSharedPreferences(Push.PREFS, Context.MODE_PRIVATE).edit().putString("deviceNames", json).apply()
    }

    // ----- misc -----

    @JavascriptInterface
    fun authenticate(id: String) = activity.runOnUiThread { activity.authenticate { ok -> emit("onAuth", id, ok) } }

    @JavascriptInterface
    fun canAuthenticate(): Boolean = activity.canAuthenticate()

    @JavascriptInterface
    fun copyText(text: String) {
        val cm = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText("Remota", text))
    }

    @JavascriptInterface
    fun openExternal(url: String) {
        activity.runOnUiThread {
            runCatching { activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
        }
    }

    /** A pairing link or notification tap that arrived before the page was ready. */
    @JavascriptInterface
    fun takePending(): String? = activity.takePending()

    @JavascriptInterface
    fun appVersion(): String = BuildConfigCompat.versionName(activity)
}

object BuildConfigCompat {
    fun versionName(context: Context): String =
        runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "" }.getOrDefault("")
}
