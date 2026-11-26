package online.freeappstore.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AppInfoTest {
    @Test fun labelAndReleaseNotes() {
        val info = AppInfo("0.3.0", "57", "abc1234")
        assertEquals("0.3.0 (57, abc1234)", info.label)
        assertEquals("https://github.com/freeappstore-online/platform/releases/tag/android-v0.3.0", info.notesUrl)
    }

    /** The build carries android/version.properties and the commit; without ANDROID_BUILD_NUMBER it is a dev build. */
    @Test fun currentBuild() {
        val info = AppInfo.current
        assertTrue(info.version, Regex("""\d+\.\d+\.\d+""").matches(info.version))
        assertTrue(info.commit, Regex("[0-9a-f]{7}").matches(info.commit))
        assertEquals(if (System.getenv("ANDROID_BUILD_NUMBER") == null) "dev" else System.getenv("ANDROID_BUILD_NUMBER"), info.build)
    }
}
