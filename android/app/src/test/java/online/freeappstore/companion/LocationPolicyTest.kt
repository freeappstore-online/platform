package online.freeappstore.companion

import org.junit.Assert.*
import org.junit.Test

class LocationPolicyTest {
    private val app = ConnectedApp("run", "Run", "Routes", "Disclosure", "1", "grant-one", 1000)
    @Test fun recipientsRequireConsentAndRespectLocalRevocation() {
        assertEquals(emptyList<String>(), LocationPolicy.recipients(listOf(app), emptySet(), 999))
        assertEquals(listOf("grant-one"), LocationPolicy.recipients(listOf(app), emptySet(), 1000))
        assertEquals(emptyList<String>(), LocationPolicy.recipients(listOf(app), setOf("run"), 1001))
        assertEquals(emptyList<String>(), LocationPolicy.recipients(listOf(app.copy(grantId = null)), emptySet(), 1001))
    }
    /** With every granted app paused or revoked there is no recipient, which is the condition LocationService stops on. */
    @Test fun noRecipientsWhenEveryGrantedAppIsExcluded() {
        val walk = ConnectedApp("walk", "Walk", "Routes", "Disclosure", "1", "grant-two", 1000)
        assertEquals(listOf("grant-two"), LocationPolicy.recipients(listOf(app, walk), setOf("run"), 2000))
        assertEquals(emptyList<String>(), LocationPolicy.recipients(listOf(app, walk), setOf("run", "walk"), 2000))
    }
    @Test fun gpsMustBeFreshAccurateAndHaveRecipients() {
        val p = TrackPoint("point", 20_000, -36.4, 148.4, 5f, listOf("grant-one"))
        assertTrue(LocationPolicy.valid(p, 20_000))
        assertFalse(LocationPolicy.valid(p.copy(at = 4_999), 20_000))
        assertFalse(LocationPolicy.valid(p.copy(at = 22_001), 20_000))
        assertFalse(LocationPolicy.valid(p.copy(lat = Double.NaN), 20_000))
        assertFalse(LocationPolicy.valid(p.copy(lng = 181.0), 20_000))
        assertFalse(LocationPolicy.valid(p.copy(accuracy = 101f), 20_000))
        assertFalse(LocationPolicy.valid(p.copy(grants = emptyList()), 20_000))
    }
}
