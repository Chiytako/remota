package dev.remota.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import org.json.JSONObject
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.UnifiedPush
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage

/**
 * Background notifications without Google services or a server of ours: UnifiedPush hands us a
 * Web Push endpoint (served by a distributor app such as ntfy). Each machine sends standard,
 * end-to-end encrypted Web Push to it; only this app holds the key to read them.
 */
object Push {
    const val PREFS = "remota.push"
    const val CHANNEL = "agents"

    fun status(context: Context): JSONObject {
        val p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        return JSONObject()
            .put("distributors", org.json.JSONArray(UnifiedPush.getDistributors(context)))
            .put("distributor", UnifiedPush.getAckDistributor(context))
            .put("endpoint", p.getString("endpoint", null))
            .put("p256dh", p.getString("p256dh", null))
            .put("auth", p.getString("auth", null))
            .put("error", p.getString("error", null))
    }

    fun disable(context: Context) {
        UnifiedPush.unregister(context)
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .remove("endpoint").remove("p256dh").remove("auth").remove("error").apply()
        MainActivity.current?.bridge?.emit("onPush", status(context))
    }

    fun ensureChannel(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL, context.getString(R.string.channel_agents), NotificationManager.IMPORTANCE_HIGH).apply {
                    description = context.getString(R.string.channel_agents_desc)
                },
            )
        }
    }

    fun show(context: Context, payload: JSONObject) {
        ensureChannel(context)
        val device = payload.optString("device", "")
        val session = payload.optString("sessionId", "")
        val names = runCatching {
            JSONObject(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("deviceNames", "{}") ?: "{}")
        }.getOrDefault(JSONObject())
        val machine = names.optString(device, "")
        val title = payload.optString("title", "Remota").let { if (machine.isNotEmpty()) "$machine / $it" else it }

        val open = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra("device", device)
            putExtra("session", session)
        }
        val tag = payload.optString("tag", "$device:$session")
        val pending = PendingIntent.getActivity(context, tag.hashCode(), open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notification = android.app.Notification.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(payload.optString("body", ""))
            .setStyle(android.app.Notification.BigTextStyle().bigText(payload.optString("body", "")))
            .setAutoCancel(true)
            .setContentIntent(pending)
            .setCategory(android.app.Notification.CATEGORY_MESSAGE)
            .build()
        // Same session → same notification, updated in place rather than stacking.
        context.getSystemService(NotificationManager::class.java).notify(tag, 1, notification)
    }

    fun canPost(context: Context): Boolean =
        Build.VERSION.SDK_INT < 33 || context.getSystemService(NotificationManager::class.java).areNotificationsEnabled()
}

class PushServiceImpl : PushService() {
    override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) {
        val keys = endpoint.pubKeySet
        getSharedPreferences(Push.PREFS, MODE_PRIVATE).edit()
            .putString("endpoint", endpoint.url)
            .putString("p256dh", keys?.pubKey)
            .putString("auth", keys?.auth)
            .remove("error")
            .apply()
        // The page re-registers the new endpoint with every machine.
        MainActivity.current?.bridge?.emit("onPush", Push.status(this))
    }

    override fun onMessage(message: PushMessage, instance: String) {
        val payload = runCatching { JSONObject(String(message.content, Charsets.UTF_8)) }
            .getOrElse { JSONObject().put("title", "Remota").put("body", String(message.content, Charsets.UTF_8)) }
        Push.show(this, payload)
    }

    override fun onRegistrationFailed(reason: FailedReason, instance: String) {
        getSharedPreferences(Push.PREFS, MODE_PRIVATE).edit().putString("error", reason.name).apply()
        MainActivity.current?.bridge?.emit("onPush", Push.status(this))
    }

    override fun onUnregistered(instance: String) {
        getSharedPreferences(Push.PREFS, MODE_PRIVATE).edit().remove("endpoint").remove("p256dh").remove("auth").apply()
        MainActivity.current?.bridge?.emit("onPush", Push.status(this))
    }
}
