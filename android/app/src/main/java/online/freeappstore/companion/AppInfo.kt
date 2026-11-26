package online.freeappstore.companion

/**
 * Version, build and source commit for About and the attempt records (#832). The version is `versionName` from
 * android/version.properties; CI numbers each build with ANDROID_BUILD_NUMBER, and a build without one says "dev".
 */
internal data class AppInfo(val version: String, val build: String, val commit: String) {
    /** "0.3.0 (57, abc1234)", or "0.3.0 (dev, abc1234)" for a local build. */
    val label get() = "$version ($build, $commit)"
    /** The GitHub release notes for this version (docs/versioning.md). */
    val notesUrl get() = "https://github.com/freeappstore-online/platform/releases/tag/android-v$version"

    companion object {
        val current = AppInfo(BuildConfig.VERSION_NAME, if (BuildConfig.FAS_DEV_BUILD) "dev" else BuildConfig.VERSION_CODE.toString(), BuildConfig.FAS_COMMIT)
    }
}
