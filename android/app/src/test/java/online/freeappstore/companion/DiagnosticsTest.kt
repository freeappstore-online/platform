package online.freeappstore.companion

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** Copy diagnostics (#813): the latest jobs' records, never their text, audio, notes or credentials. */
class DiagnosticsTest {
    private fun job(i: Int) = Contribution("j$i", "books", "book/$i", at = i * 1_000L, status = "rejected", reason = "audio is too short",
        inputPreview = "SECRET INPUT $i", durationMs = 1_200, bytes = 4_000, record = """{"jobId":"j$i","runner":"android","reason":"submitted"}""",
        submissionId = "s$i", report = Report(false, "SECRET NOTE", 5))

    @Test fun keepsTheLatestFiftyJobsNewestFirstWithoutTextOrNotes() {
        val json = diagnosticsJson(JSONObject().put("runner", "android"), "no_work · 2 submitted", ContributeSettings(),
            (1..60).map(::job), 1_000_000L)
        val jobs = json.getJSONArray("jobs")
        assertEquals(DIAGNOSTIC_JOBS, jobs.length())
        assertEquals("j60", jobs.getJSONObject(0).getString("jobId"))
        assertEquals("submitted", jobs.getJSONObject(0).getJSONObject("attempt").getString("reason"))
        assertEquals(false, jobs.getJSONObject(0).getBoolean("reportedGood"))
        assertEquals("no_work · 2 submitted", json.getString("lastRunEnd"))
        assertEquals("android", json.getJSONObject("capabilities").getString("runner"))
        val text = json.toString()
        assertFalse(text.contains("SECRET"))
    }
}
