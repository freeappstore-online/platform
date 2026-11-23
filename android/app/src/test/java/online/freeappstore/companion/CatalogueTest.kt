package online.freeappstore.companion

import org.junit.Assert.*
import org.junit.Test

/** Fixture: three live registry.json entries plus invalid ones. */
internal val REGISTRY = """
{"apps":[
 {"id":"language","name":"Language","category":"Learning","icon":"&#127463;","iconBg":"#dc2626","description":"Flashcards, cloze exercises, and speech practice.","appUrl":"https://language.freeappstore.online","developer":"FreeAppStore","permissions":["microphone"],"repo":"freeappstore-online/language"},
 {"id":"hanzi-practice","name":"Hanzi Practice","category":"lifestyle","icon":"⏱","iconBg":"#abc","description":"Write Chinese characters.","appUrl":"https://hanzi.freeappstore.online","permissions":[{"name":"screen","reason":"Record a tab you choose."},{"name":"clipboard","reason":"Copy links."},{"name":"telepathy"}]},
 {"id":"cafe","name":"Café Finder","category":"Lifestyle","icon":"","iconBg":"red","description":"Find a crème brûlée nearby.","appUrl":"https://cafe.freeappstore.online/app/","permissions":[]},
 {"id":"Bad","name":"Upper id","appUrl":"https://bad.freeappstore.online"},
 {"id":"http","name":"Plain http","appUrl":"http://http.freeappstore.online"},
 {"id":"evil","name":"Elsewhere","appUrl":"https://evil.example"},
 {"id":"lookalike","name":"Lookalike","appUrl":"https://x.freeappstore.online.evil.example"},
 {"id":"noname","name":"  ","appUrl":"https://noname.freeappstore.online"},
 {"id":"language","name":"Duplicate","appUrl":"https://language.freeappstore.online"},
 "not an object",
 {"id":"other","name":"Other","category":"Other (specify in description)","icon":"&#xZZ;x","appUrl":"https://other.freeappstore.online"}
]}
""".trimIndent()

class CatalogueTest {
    private val apps = Catalogue.decode(REGISTRY)!!
    private fun app(id: String) = apps.single { it.id == id }

    @Test fun decodesEachEntryOnItsOwnAndSkipsInvalidOnes() {
        assertEquals(listOf("language", "hanzi-practice", "cafe", "other"), apps.map { it.id })
        assertEquals("Language", app("language").name)
        assertEquals("https://hanzi.freeappstore.online", app("hanzi-practice").appUrl)
    }

    @Test fun notTheRegistryShapeIsNull() {
        assertNull(Catalogue.decode("<html>"))
        assertNull(Catalogue.decode("{\"items\":[]}"))
        assertEquals(emptyList<CatalogueApp>(), Catalogue.decode("{\"apps\":[]}"))
    }

    @Test fun decodesEntityEmojiAndFallsBackToTheFirstLetter() {
        assertEquals("🇧", app("language").icon)
        assertEquals("⏱", app("hanzi-practice").icon)
        assertEquals("C", app("cafe").icon)
        assertEquals("&#xZZ;x", app("other").icon)
        assertEquals("📞", Catalogue.emoji("&#128222;", "x"))
        assertEquals("❤", Catalogue.emoji("&#10084;", "x"))
        assertEquals("📞", Catalogue.emoji("&#x1F4DE;", "x"))
        assertEquals("&#55357;", Catalogue.emoji("&#55357;", "x"))
    }

    @Test fun iconBackgroundIsAValidatedHexWithTheStorefrontDefault() {
        assertEquals("#dc2626", app("language").iconBg)
        assertEquals("#abc", app("hanzi-practice").iconBg)
        assertEquals(Catalogue.DEFAULT_ICON_BG, app("cafe").iconBg)
        assertEquals(0xffdc2626, Catalogue.argb("#dc2626"))
        assertEquals(0xffaabbcc, Catalogue.argb("#abc"))
        assertEquals(0x80112233, Catalogue.argb("#11223380"))
    }

    @Test fun categoryCaseIsNormalisedLikeTheStorefront() {
        assertEquals("Lifestyle", app("hanzi-practice").category)
        assertEquals("Other", app("other").category)
        assertEquals("Brain Training", Catalogue.categoryLabel("brain-training"))
        assertEquals("Other", Catalogue.categoryLabel(null))
        val categories = Catalogue.categories(apps)
        assertEquals(listOf("Lifestyle", "Learning", "Other"), categories.map { it.first })
        assertEquals(listOf("hanzi-practice", "cafe"), categories[0].second.map { it.id })
    }

    @Test fun permissionsKeepKnownIdsInDisplayOrder() {
        assertEquals(listOf(CatalogueApp.Permission("microphone", "")), app("language").permissions)
        assertEquals(listOf("clipboard", "screen"), app("hanzi-practice").permissions!!.map { it.id })
        assertEquals("Record a tab you choose.", app("hanzi-practice").permissions!![1].reason)
        assertEquals(emptyList<CatalogueApp.Permission>(), app("cafe").permissions)
        assertNull(app("other").permissions)
    }

    @Test fun openAddsInstallToTheValidatedAppUrl() {
        assertEquals("https://language.freeappstore.online/?install=1", Catalogue.installUrl(app("language").appUrl))
        assertEquals("https://hanzi.freeappstore.online/?install=1", Catalogue.installUrl(app("hanzi-practice").appUrl))
        assertEquals("https://cafe.freeappstore.online/app/?install=1", Catalogue.installUrl(app("cafe").appUrl))
        assertEquals("https://a.freeappstore.online/?x=1&install=1", Catalogue.installUrl("https://a.freeappstore.online/?x=1"))
    }

    @Test fun searchIsCaseAndDiacriticInsensitiveOverEveryField() {
        assertEquals(listOf("cafe"), Catalogue.search(apps, "CAFE").map { it.id })
        assertEquals(listOf("cafe"), Catalogue.search(apps, "creme brulee").map { it.id })
        assertEquals(listOf("hanzi-practice"), Catalogue.search(apps, "screen sharing").map { it.id })
        assertEquals(listOf("language"), Catalogue.search(apps, "freeappstore").map { it.id })
        assertEquals(listOf("hanzi-practice", "cafe"), Catalogue.search(apps, "lifestyle").map { it.id })
        assertEquals(emptyList<CatalogueApp>(), Catalogue.search(apps, "zzz"))
        assertEquals(apps, Catalogue.search(apps, "  "))
    }

    @Test fun featuredAndAllApps() {
        assertEquals(listOf("language", "hanzi-practice"), Catalogue.featured(apps, 2).map { it.id })
        assertEquals(listOf("Café Finder", "Hanzi Practice", "Language", "Other"), Catalogue.sortedByName(apps).map { it.name })
    }
}
