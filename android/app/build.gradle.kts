import java.net.URI
import java.security.MessageDigest
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}
val releaseVersion = Properties().apply {
    rootProject.file("version.properties").inputStream().use { load(it) }
}
// CI builds number themselves with ANDROID_BUILD_NUMBER; a build without it is a dev build and says so (#832).
val ciBuildNumber: String? = System.getenv("ANDROID_BUILD_NUMBER")
val buildNumber = (ciBuildNumber ?: releaseVersion.getProperty("versionCode")).toInt()
require(buildNumber in 1..2_100_000_000) { "Android versionCode is out of range" }
val commit = providers.exec { commandLine("git", "rev-parse", "--short=7", "HEAD") }.standardOutput.asText.get().trim()
val uploadStore = System.getenv("ANDROID_UPLOAD_KEYSTORE_PATH")
android {
    namespace = "online.freeappstore.companion"
    compileSdk = 36
    defaultConfig {
        applicationId = "online.freeappstore.companion"
        minSdk = 29
        targetSdk = 36
        versionCode = buildNumber
        versionName = releaseVersion.getProperty("versionName")
        buildConfigField("String", "FAS_COMMIT", "\"$commit\"")
        buildConfigField("boolean", "FAS_DEV_BUILD", "${ciBuildNumber == null}")
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    // Release builds are signed with the FAS upload key; scripts/build-android-release.sh restores it (#651).
    signingConfigs {
        if (!uploadStore.isNullOrBlank()) create("upload") {
            storeFile = file(uploadStore)
            storePassword = System.getenv("ANDROID_UPLOAD_KEYSTORE_PASSWORD")
            keyAlias = System.getenv("ANDROID_UPLOAD_KEY_ALIAS")
            keyPassword = System.getenv("ANDROID_UPLOAD_KEY_PASSWORD")
        }
    }
    buildTypes {
        release {
            if (!uploadStore.isNullOrBlank()) signingConfig = signingConfigs.getByName("upload")
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { compose = true; buildConfig = true }
}
// A release task must never quietly produce an unsigned artifact or use a debug key.
gradle.taskGraph.whenReady {
    if (allTasks.any { it.project == project && it.name in listOf("assembleRelease", "bundleRelease", "packageRelease", "signReleaseBundle") }) {
        require(!uploadStore.isNullOrBlank() && listOf("ANDROID_UPLOAD_KEYSTORE_PASSWORD", "ANDROID_UPLOAD_KEY_ALIAS", "ANDROID_UPLOAD_KEY_PASSWORD").all { !System.getenv(it).isNullOrBlank() }) {
            "Release signing is required. Use scripts/build-android-release.sh with FAS upload credentials."
        }
    }
}
// Kokoro TTS for Contribute (#731): the official sherpa-onnx Android AAR (Apache-2.0). It ships only as a GitHub release
// asset (not on Maven Central), so it is fetched once into app/libs (untracked) and must match the pinned SHA-256.
val sherpaOnnxVersion = "2.0.3"
val sherpaOnnxSha256 = "4c766e2e74c9d33d595338c21fe3b305c73ba45d47e96a235675c33142a2ec50"
val sherpaOnnxAar = file("libs/sherpa-onnx-$sherpaOnnxVersion.aar")
fun sha256(file: File) = MessageDigest.getInstance("SHA-256").let { md ->
    file.inputStream().use { input -> val buffer = ByteArray(1 shl 16); while (true) { val n = input.read(buffer); if (n < 0) break; md.update(buffer, 0, n) } }
    md.digest().joinToString("") { "%02x".format(it) }
}
if (!sherpaOnnxAar.isFile || sha256(sherpaOnnxAar) != sherpaOnnxSha256) {
    sherpaOnnxAar.parentFile.mkdirs()
    val part = File(sherpaOnnxAar.path + ".part")
    URI("https://github.com/k2-fsa/sherpa-onnx/releases/download/v$sherpaOnnxVersion/sherpa-onnx-$sherpaOnnxVersion.aar").toURL()
        .openStream().use { input -> part.outputStream().use { input.copyTo(it) } }
    check(sha256(part) == sherpaOnnxSha256) { part.delete(); "sherpa-onnx $sherpaOnnxVersion AAR does not match its pinned SHA-256" }
    check(part.renameTo(sherpaOnnxAar))
}
dependencies {
    implementation(files(sherpaOnnxAar))
    // Unpacks the voice model's .tar.bz2 (#731).
    implementation("org.apache.commons:commons-compress:1.28.0")
    val composeBom = platform("androidx.compose:compose-bom:2025.10.00")
    implementation(composeBom)
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui-tooling-preview")
    debugImplementation("androidx.compose.ui:ui-tooling")
    implementation("androidx.activity:activity-compose:1.11.0")
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.9.4")
    implementation("androidx.work:work-runtime-ktx:2.10.5")
    testImplementation("junit:junit:4.13.2")
    // The real org.json for JVM unit tests (android.jar only has stubs). Test-only.
    testImplementation("org.json:json:20250517")
    androidTestImplementation(composeBom)
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test:runner:1.7.0")
    // The BOM's ui-test pulls Espresso 3.5, which calls InputManager.getInstance (removed in API 35).
    androidTestImplementation("androidx.test.espresso:espresso-core:3.7.0")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
