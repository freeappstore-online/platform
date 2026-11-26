package online.freeappstore.companion

import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import org.json.JSONObject

class ApiFailure(val status: Int, message: String) : Exception(message)

/** Open only so instrumented tests can answer for the server; the app constructs this one. */
open class FasApi {
    companion object {
        const val ORIGIN = "https://api.freeappstore.online"
        /** The device credential goes to the native routes and to the contributor routes of community generation (#731). */
        private val ALLOWED = Regex("^/(native/|apps/[a-z0-9][a-z0-9-]{0,62}/generation/)")
    }
    /** Only the platform origin receives the narrow native credential; redirects are refused. */
    open fun request(method: String, path: String, token: String? = null, body: JSONObject? = null): JSONObject =
        send(method, path, token, emptyMap()) { connection ->
            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { it.write(body.toString().toByteArray()) }
            }
        }
    /** A `POST` without a body and with extra [headers] (the lease extension, #783). */
    open fun post(path: String, token: String, headers: Map<String, String>): JSONObject = send("POST", path, token, headers) { }
    /** A multipart `PUT`/`POST` with one `file` part (streamed from disk) and an optional `meta` JSON part (#727). */
    open fun upload(method: String, path: String, token: String, headers: Map<String, String>, file: File, contentType: String, meta: JSONObject? = null): JSONObject =
        send(method, path, token, headers) { connection ->
            val boundary = "fas-" + UUID.randomUUID()
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")
            connection.setChunkedStreamingMode(64 * 1024)
            connection.outputStream.buffered().use { out ->
                fun part(disposition: String, type: String) =
                    out.write("--$boundary\r\nContent-Disposition: form-data; $disposition\r\nContent-Type: $type\r\n\r\n".toByteArray())
                part("name=\"file\"; filename=\"${file.name}\"", contentType)
                file.inputStream().use { it.copyTo(out) }
                out.write("\r\n".toByteArray())
                if (meta != null) {
                    part("name=\"meta\"", "application/json")
                    out.write(meta.toString().toByteArray()); out.write("\r\n".toByteArray())
                }
                out.write("--$boundary--\r\n".toByteArray())
            }
        }
    private fun send(method: String, path: String, token: String?, headers: Map<String, String>, write: (HttpURLConnection) -> Unit): JSONObject {
        require(ALLOWED.containsMatchIn(path))
        val connection = URL("$ORIGIN/v1$path").openConnection() as HttpURLConnection
        try {
            connection.requestMethod = method
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 15_000; connection.readTimeout = 20_000
            connection.setRequestProperty("Accept", "application/json")
            if (token != null) connection.setRequestProperty("Authorization", "Bearer $token")
            headers.forEach { (k, v) -> connection.setRequestProperty(k, v) }
            write(connection)
            val code = connection.responseCode
            val stream = if (code in 200..299) connection.inputStream else connection.errorStream
            val raw = stream?.bufferedReader()?.use { it.readText() } ?: "{}"
            val result = try { JSONObject(raw) } catch (_: Exception) { JSONObject() }
            if (code !in 200..299) throw ApiFailure(code, result.optString("error", "Could not reach FreeAppStore ($code)."))
            return result
        } finally { connection.disconnect() }
    }
}
