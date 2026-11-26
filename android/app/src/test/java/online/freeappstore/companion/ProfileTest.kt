package online.freeappstore.companion

import org.junit.Assert.*
import org.junit.Test

/** #829: the profile as `/native/me` sends it, kept on the phone. */
class ProfileTest {
    @Test fun parsesAGithubAccount() {
        val p = Profile.parse("""{"user":{"id":"gh:1","name":"Alex","login":"alex","provider":"github","avatarUrl":"https://avatars.githubusercontent.com/u/1",
            "email":null,"roles":["user","creator"],"appCount":3},"device":{"id":"d","label":"Google Pixel 8","createdAt":10,"expiresAt":20}}""")!!
        assertEquals(Profile("gh:1", "Alex", "alex", "github", "https://avatars.githubusercontent.com/u/1", null, listOf("user", "creator"), 3, "Google Pixel 8", 10, 20), p)
        assertEquals("@alex", p.account); assertEquals("GitHub", p.providerName)
        assertTrue(p.creator)
    }
    @Test fun aGoogleAccountShowsItsProviderAndNoInsecureAvatar() {
        val p = Profile.parse("""{"user":{"id":"google:9","name":"Gail","login":null,"provider":"google","avatarUrl":"http://x/a.png","email":"g@example.com","roles":["user"],"appCount":0},"device":{}}""")!!
        assertEquals("Google", p.account)
        assertNull(p.avatarUrl)
        assertEquals("g@example.com", p.email)
        assertFalse(p.creator)
    }
    @Test fun anOlderServerOrNothingStored() {
        assertNull(Profile.parse(""))
        val p = Profile.parse("""{"user":{"id":"gh:1","name":"alice"},"device":{"label":"Phone","expiresAt":5}}""")!!
        assertEquals("github", p.provider); assertEquals(listOf("user"), p.roles); assertEquals(0L, p.pairedAt)
    }
}
