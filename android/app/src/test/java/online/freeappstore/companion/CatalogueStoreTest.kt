package online.freeappstore.companion

import java.io.File
import java.net.ServerSocket
import java.net.URL
import java.nio.file.Files
import kotlin.concurrent.thread
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

/** The real client against a loopback server: conditional GET, cache, stale, and no credentials or redirects. */
class CatalogueStoreTest {
    private class Seen(val method: String, val path: String, val headers: Map<String, List<String>>)
    private lateinit var server: ServerSocket
    private lateinit var dir: File
    private val seen = java.util.concurrent.CopyOnWriteArrayList<Seen>()
    /** Next response: status, body, etag. */
    @Volatile private var reply: Triple<Int, String?, String?> = Triple(200, REGISTRY, "\"v1\"")

    @Before fun start() {
        dir = Files.createTempDirectory("catalogue").toFile()
        server = ServerSocket(0, 50, java.net.InetAddress.getLoopbackAddress())
        thread(isDaemon = true) {
            while (!server.isClosed) {
                val socket = try { server.accept() } catch (_: Exception) { break }
                socket.use { s ->
                    val reader = s.getInputStream().bufferedReader()
                    val (method, path) = reader.readLine().split(" ")
                    val headers = HashMap<String, MutableList<String>>()
                    while (true) {
                        val line = reader.readLine() ?: break
                        if (line.isEmpty()) break
                        val (k, v) = line.split(":", limit = 2)
                        headers.getOrPut(k.trim().lowercase()) { mutableListOf() }.add(v.trim())
                    }
                    seen += Seen(method, path, headers)
                    val (status, body, etag) = reply
                    val bytes = body?.toByteArray() ?: ByteArray(0)
                    val head = StringBuilder("HTTP/1.1 $status X\r\nConnection: close\r\nContent-Length: ${bytes.size}\r\n")
                    etag?.let { head.append("ETag: $it\r\n") }
                    if (status == 302) head.append("Location: http://127.0.0.1:${server.localPort}/elsewhere.json\r\n")
                    s.getOutputStream().apply { write(head.append("\r\n").toString().toByteArray()); write(bytes); flush() }
                }
            }
        }
    }
    @After fun stop() { server.close(); dir.deleteRecursively() }

    private fun store() = CatalogueStore(dir, CatalogueClient(URL("http://127.0.0.1:${server.localPort}/registry.json")))

    @Test fun productionClientTargetsTheFixedRegistry() {
        assertEquals("https://freeappstore.online/registry.json", CatalogueClient.REGISTRY_URL)
    }

    @Test fun firstLoadCachesAndARelaunchPublishesTheCacheBeforeAnyRequest() {
        val first = store()
        assertTrue(first.apps.isEmpty())
        first.refresh()
        assertEquals(4, first.apps.size)
        assertFalse(first.stale)
        assertNull(seen.single().headers["if-none-match"])
        val relaunched = store()
        assertEquals(4, relaunched.apps.size)
        assertEquals(1, seen.size)
    }

    @Test fun revalidatesWithIfNoneMatchAndKeepsTheCacheOn304() {
        store().refresh()
        reply = Triple(304, null, null)
        val again = store()
        again.refresh()
        assertEquals(listOf("\"v1\""), seen.last().headers["if-none-match"])
        assertEquals(4, again.apps.size)
        assertFalse(again.stale)
    }

    @Test fun aNew200ReplacesTheCache() {
        store().refresh()
        reply = Triple(200, """{"apps":[{"id":"run","name":"Run","appUrl":"https://run.freeappstore.online"}]}""", "\"v2\"")
        val again = store()
        again.refresh()
        assertEquals(listOf("run"), again.apps.map { it.id })
        assertEquals(listOf("run"), store().apps.map { it.id })
    }

    @Test fun malformedEmptyOrFailedResponsesKeepTheOldCopyAndMarkItStale() {
        val s = store()
        s.refresh()
        for (r in listOf(Triple(200, "<html>", null), Triple(200, """{"apps":[]}""", null), Triple(500, "oops", null), Triple(200, "x".repeat(CatalogueClient.MAX_BYTES + 1), null))) {
            reply = r
            s.refresh()
            assertTrue(s.stale)
            assertEquals(4, s.apps.size)
        }
        assertEquals(4, store().apps.size)
    }

    @Test fun redirectsAreNotFollowed() {
        val s = store()
        reply = Triple(302, null, null)
        s.refresh()
        assertTrue(s.stale)
        assertTrue(s.apps.isEmpty())
        assertEquals(listOf("/registry.json"), seen.map { it.path })
    }

    @Test fun noRequestCarriesCredentials() {
        val s = store()
        s.refresh(); s.refresh()
        assertEquals(2, seen.size)
        for (r in seen) {
            assertEquals("GET", r.method)
            assertNull(r.headers["authorization"])
            assertNull(r.headers["cookie"])
        }
    }

    @Test fun unreachableMarksStale() {
        val s = store()
        server.close()
        s.refresh()
        assertTrue(s.stale)
    }
}
