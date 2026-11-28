package online.freeappstore.companion

import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** Versions (#833) and pairing by code (#845): the request, its headers, link parsing, rejections and the QR reader. */
class PairCodeTest {
    /** Answers one request without the network and keeps what was sent. */
    private class Recorded(url: URL, private val status: Int, private val reply: String) : HttpURLConnection(url) {
        val sent = ByteArrayOutputStream()
        override fun connect() {}
        override fun disconnect() {}
        override fun usingProxy() = false
        override fun getResponseCode() = status
        override fun getOutputStream() = sent
        override fun getInputStream() = reply.byteInputStream()
        override fun getErrorStream() = reply.byteInputStream()
    }
    private class Api(val status: Int = 200, val reply: String = "{}") : FasApi() {
        val calls = mutableListOf<Recorded>()
        override fun open(url: URL) = Recorded(url, status, reply).also { calls += it }
    }

    @Test fun everyRequestCarriesTheVersionAndTheClient() {
        val api = Api(reply = """{"user":{"id":"u1"}}""")
        api.request("GET", "/native/me", "ndev_test")
        api.post("/generation/open", "ndev_test", mapOf("X-Other" to "1"))
        api.request("GET", "/generation/backlog", "ndev_test")
        assertThrows(IllegalArgumentException::class.java) {
            api.request("GET", "/generation/backlog/other", "ndev_test")
        }
        assertEquals(3, api.calls.size)
        for (call in api.calls) {
            assertEquals("android", call.getRequestProperty("X-FAS-Client"))
            assertEquals(AppInfo.current.label, call.getRequestProperty("X-FAS-App-Version"))
            assertEquals("Bearer ndev_test", call.getRequestProperty("Authorization"))
        }
        assertTrue("the backend ignores a label outside this set", Regex("^[A-Za-z0-9 .,()+\\-_]{1,64}$").matches(AppInfo.current.label))
        assertTrue(Regex("^[A-Za-z0-9 .,()+\\-_]{1,64}$").matches(AppInfo("0.4.0", "57", "abc1234").label))
    }

    @Test fun aCodeIsPostedAsTypedWithTheLabelAndNoCredential() {
        val api = Api(reply = """{"token":"ndev_code","deviceId":"d2"}""")
        val result = api.request("POST", "/native/auth/code", body = PairCode.body(" abcd-efgh-jkmn-pqrs\n", "Google Pixel 8"))
        assertEquals("ndev_code", result.getString("token"))
        val call = api.calls.single()
        assertEquals("POST", call.requestMethod)
        assertEquals("https://api.freeappstore.online/v1/native/auth/code", call.url.toString())
        assertNull(call.getRequestProperty("Authorization"))
        assertEquals("application/json", call.getRequestProperty("Content-Type"))
        assertEquals("android", call.getRequestProperty("X-FAS-Client"))
        assertEquals(AppInfo.current.label, call.getRequestProperty("X-FAS-App-Version"))
        val body = JSONObject(call.sent.toString())
        assertEquals("sent as typed, trimmed; the server normalizes it", "abcd-efgh-jkmn-pqrs", body.getString("code"))
        assertEquals("Google Pixel 8", body.getString("label"))
        assertEquals(2, body.length())
    }

    @Test fun anEmptyOrOverlongCodeIsNeverSent() {
        assertNull(PairCode.body("  ", "Pixel"))
        assertNull(PairCode.body("A".repeat(65), "Pixel"))
        assertEquals(80, PairCode.body("ABCD", "x".repeat(200))!!.getString("label").length)
    }

    @Test fun rejectedCodesSayWhatToDo() {
        for (status in PairCode.REJECTED) {
            val failure = runCatching { Api(status, """{"error":"server text"}""").request("POST", "/native/auth/code", body = PairCode.body("ABCD", "Pixel")) }
                .exceptionOrNull() as ApiFailure
            assertEquals(status, failure.status)
        }
        assertEquals("This code expired or was already used. Get a new code and try again.", PairCode.failure(403))
        assertEquals("That is not a FreeAppStore code. Check it and try again.", PairCode.failure(400))
        assertEquals("Too many tries from this network today. Try again tomorrow.", PairCode.failure(429))
        assertEquals("The account that showed this code no longer exists.", PairCode.failure(401))
        assertEquals(setOf(400, 401, 403, 429), PairCode.REJECTED)
    }

    @Test fun onlyFreeAppStorePairLinksCarryACode() {
        assertEquals("ABCDEFGHJKMNPQRS", PairCode.fromLink("freeappstore://native/pair?code=ABCDEFGHJKMNPQRS"))
        assertEquals("abcd-efgh", PairCode.fromLink("freeappstore://native/pair?other=1&code=abcd-efgh"))
        assertEquals("ABCD EFGH", PairCode.fromLink("freeappstore://native/pair?code=ABCD%20EFGH"))
        assertNull(PairCode.fromLink("freeappstore://native/pair"))
        assertNull(PairCode.fromLink("freeappstore://native/pair?code="))
        assertNull(PairCode.fromLink("freeappstore://native/pair?code=%zz"))
        assertNull(PairCode.fromLink("freeappstore://native/connected?code=ABCD"))
        assertNull(PairCode.fromLink("freeappstore://native/pair/more?code=ABCD"))
        assertNull(PairCode.fromLink("freeappstore://evil/pair?code=ABCD"))
        assertNull(PairCode.fromLink("https://native/pair?code=ABCD"))
        assertNull(PairCode.fromLink("https://freeappstore.online/native/pair?code=ABCD"))
        assertNull(PairCode.fromLink("ABCDEFGHJKMNPQRS"))
        assertNull(PairCode.fromLink("not a link at all"))
    }

    /** A camera frame's luminance plane, rows padded as CameraX pads them, holding the console's QR code. */
    @Test fun theReaderFindsThePairLinkInAFrame() {
        val link = "freeappstore://native/pair?code=ABCDEFGHJKMNPQRS"
        val width = 480; val height = 360; val stride = 512
        val frame = ByteArray(stride * height) { 0xC8.toByte() } // a light background
        val matrix = QRCodeWriter().encode(link, BarcodeFormat.QR_CODE, 240, 240)
        for (y in 0 until matrix.height) for (x in 0 until matrix.width) if (matrix[x, y]) frame[(y + 60) * stride + x + 120] = 0x10
        val read = QrReader().read(frame, stride, width, height)
        assertEquals(link, read)
        assertEquals("ABCDEFGHJKMNPQRS", PairCode.fromLink(read!!))
        assertNull("an empty frame has no code", QrReader().read(ByteArray(stride * height) { 0x80.toByte() }, stride, width, height))
    }
}
