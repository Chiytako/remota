package dev.remota.app

import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.security.MessageDigest
import javax.net.ssl.SSLException

class DeviceNetworkTest {
    private lateinit var server: MockWebServer
    private lateinit var cert: HeldCertificate

    @Before
    fun setUp() {
        // A self-signed certificate no CA vouches for: only the pin can make it trusted.
        cert = HeldCertificate.Builder().addSubjectAlternativeName("remota.invalid").build()
        server = MockWebServer()
        server.useHttps(HandshakeCertificates.Builder().heldCertificate(cert).build().sslSocketFactory(), false)
        server.start()
    }

    @After
    fun tearDown() = server.shutdown()

    private fun pinOf(held: HeldCertificate): String =
        java.util.Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-256").digest(held.keyPair.public.encoded))

    @Test
    fun pinnedKeyIsTrustedWithoutAnyCertificateAuthority() {
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        // Connecting by IP: the certificate's name doesn't match, the pinned key is what counts.
        val url = server.url("/api/ping").newBuilder().host("127.0.0.1").build()
        val res = DeviceNetwork.client(pinOf(cert)).newCall(Request.Builder().url(url).build()).execute()
        assertEquals(200, res.code)
        assertEquals("""{"ok":true}""", res.body!!.string())
    }

    @Test
    fun anyOtherKeyIsRefused() {
        server.enqueue(MockResponse().setBody("should never be read"))
        val other = HeldCertificate.Builder().build()
        try {
            DeviceNetwork.client(pinOf(other)).newCall(Request.Builder().url(server.url("/api/ping")).build()).execute()
            fail("a server with a different key must be refused")
        } catch (e: SSLException) {
            assertTrue(DeviceNetwork.describe(e), DeviceNetwork.describe(e).contains("鍵が登録時と一致しません"))
        }
    }

    @Test
    fun missingPinIsRejectedUpFront() {
        try {
            DeviceNetwork.client("")
            fail("a device without a pin must not get a client")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("remota url"))
        }
    }
}
