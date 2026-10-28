package dev.remota.app

import okhttp3.OkHttpClient
import org.json.JSONObject
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

/** A machine running Remota, as stored by the app: where it is, its token, and its pinned key. */
data class Device(val url: String, val token: String, val pin: String) {
    companion object {
        fun fromJson(json: String): Device {
            val o = JSONObject(json)
            return Device(o.getString("url").trimEnd('/'), o.getString("token"), o.optString("pin", ""))
        }
    }
}

class PinMismatchException(message: String) : CertificateException(message)

/**
 * HTTPS to each machine trusts exactly one key: the one whose SHA-256 (SubjectPublicKeyInfo) came in
 * the pairing QR code — the way SSH trusts a host key. No certificate authority is involved, so
 * nothing has to be installed on the phone and nobody else can impersonate the machine.
 */
object DeviceNetwork {
    private val clients = ConcurrentHashMap<String, OkHttpClient>()

    fun client(pin: String): OkHttpClient {
        require(pin.isNotEmpty()) { "この機器には鍵の指紋がありません。機器で `remota url` を実行し、表示された QR から追加し直してください。" }
        return clients.getOrPut(pin) { build(pin) }
    }

    private fun build(pin: String): OkHttpClient {
        val expected = java.util.Base64.getDecoder().decode(pin)
        val trust = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) =
                throw CertificateException("client certificates are not used")

            override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
                val leaf = chain.firstOrNull() ?: throw CertificateException("no certificate")
                val actual = MessageDigest.getInstance("SHA-256").digest(leaf.publicKey.encoded)
                if (!MessageDigest.isEqual(actual, expected)) {
                    throw PinMismatchException("機器の鍵が登録時と一致しません。なりすましの可能性があります（機器を再インストールした場合は、追加し直してください）。")
                }
            }

            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
        }
        val tls = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), null) }
        return OkHttpClient.Builder()
            .sslSocketFactory(tls.socketFactory, trust)
            // The pinned key is the machine's identity; the address it answers on (LAN, VPN) may vary.
            .hostnameVerifier { _, _ -> true }
            .connectTimeout(8, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(60, TimeUnit.SECONDS)
            .build()
    }

    fun describe(e: Throwable): String {
        var cause: Throwable? = e
        while (cause != null) {
            if (cause is PinMismatchException) return cause.message ?: "pin mismatch"
            cause = cause.cause
        }
        return when (e) {
            is java.net.SocketTimeoutException -> "応答がありません"
            is java.net.ConnectException, is java.net.UnknownHostException, is java.net.NoRouteToHostException -> "接続できません"
            else -> e.message ?: "接続エラー"
        }
    }
}
