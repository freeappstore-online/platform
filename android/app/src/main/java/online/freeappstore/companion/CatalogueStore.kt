package online.freeappstore.companion

import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * Credential-free client for the public registry. It never uses FasApi: the device credential stays on
 * the native API (`/v1/native/`). No Authorization, no cookies, no HTTP cache, and redirects are refused.
 */
class CatalogueClient internal constructor(private val url: URL) {
    constructor() : this(URL(REGISTRY_URL))

    class Fetched(val status: Int, val body: ByteArray?, val etag: String?)

    fun fetch(etag: String?): Fetched {
        val connection = url.openConnection() as HttpURLConnection
        try {
            connection.instanceFollowRedirects = false
            connection.useCaches = false
            connection.connectTimeout = 15_000; connection.readTimeout = 30_000
            connection.setRequestProperty("Accept", "application/json")
            if (etag != null) connection.setRequestProperty("If-None-Match", etag)
            val code = connection.responseCode
            if (code != 200 || connection.contentLengthLong > MAX_BYTES) return Fetched(code, null, null)
            return Fetched(code, connection.inputStream.use(::readCapped), connection.getHeaderField("ETag"))
        } finally { connection.disconnect() }
    }

    private fun readCapped(input: InputStream): ByteArray? {
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(16 * 1024)
        while (true) {
            val n = input.read(buffer)
            if (n < 0) return out.toByteArray()
            out.write(buffer, 0, n)
            if (out.size() > MAX_BYTES) return null
        }
    }

    companion object {
        const val REGISTRY_URL = "https://freeappstore.online/registry.json"
        /** The live file is about 95 KB; anything far larger is not the registry. */
        const val MAX_BYTES = 1_000_000
    }
}

/**
 * The public app catalogue, cached on the phone and revalidated with a conditional GET. It lives in its own
 * directory, outside LocalStore, so pairing and disconnect (`LocalStore.clear()`) keep it.
 */
class CatalogueStore(private val dir: File, private val client: CatalogueClient = CatalogueClient()) {
    private val dataFile get() = File(dir, "registry.json")
    private val etagFile get() = File(dir, "registry.etag")

    /** Published from the cache at once, so the tab is instant and works offline. */
    @Volatile var apps: List<CatalogueApp> = try { Catalogue.decode(dataFile.readText()) ?: emptyList() } catch (_: Exception) { emptyList() }
        private set
    /** The last refresh failed or returned something unusable; `apps` is the previous copy. */
    @Volatile var stale = false
        private set

    /** 304 keeps the cache; a usable 200 replaces it; anything else keeps it and marks it stale. Blocking. */
    @Synchronized fun refresh() {
        val etag = if (apps.isEmpty()) null else try { etagFile.readText().ifBlank { null } } catch (_: Exception) { null }
        val result = try { client.fetch(etag) } catch (_: Exception) { stale = true; return }
        if (result.status == 304 && apps.isNotEmpty()) { stale = false; return }
        val fresh = result.body?.takeIf { result.status == 200 }?.let { Catalogue.decode(String(it, Charsets.UTF_8)) }
        if (fresh.isNullOrEmpty()) { stale = true; return }
        // A failed write only loses the cache; the fresh copy is still shown.
        try {
            dir.mkdirs()
            write(dataFile, result.body)
            write(etagFile, (result.etag ?: "").toByteArray())
        } catch (_: Exception) { }
        apps = fresh
        stale = false
    }

    private fun write(file: File, bytes: ByteArray) {
        val tmp = File(file.parentFile, "${file.name}.tmp")
        tmp.writeBytes(bytes)
        check(tmp.renameTo(file))
    }
}
