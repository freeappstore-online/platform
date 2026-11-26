package online.freeappstore.companion

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.URL

/** Avatars already loaded this process, so switching tabs does not fetch them again. */
private val avatars = mutableMapOf<String, ImageBitmap>()

/** The account's picture, fetched without credentials; its initial until (or unless) it loads. */
@Composable
internal fun Avatar(profile: Profile, size: Dp) {
    val url = profile.avatarUrl
    val image by produceState(url?.let { avatars[it] }, url) {
        if (url == null || value != null) return@produceState
        value = withContext(Dispatchers.IO) {
            runCatching {
                val connection = URL(url).openConnection() as HttpURLConnection
                connection.connectTimeout = 10_000; connection.readTimeout = 10_000
                try { connection.inputStream.use { BitmapFactory.decodeStream(it) }?.asImageBitmap() } finally { connection.disconnect() }
            }.getOrNull()
        }?.also { avatars[url] = it }
    }
    val modifier = Modifier.size(size).clip(CircleShape)
    image?.let { Image(it, contentDescription = null, modifier, contentScale = ContentScale.Crop) }
        ?: Box(modifier.background(MaterialTheme.colorScheme.primaryContainer), contentAlignment = Alignment.Center) {
            Text(profile.name.take(1).uppercase(), color = MaterialTheme.colorScheme.onPrimaryContainer)
        }
}

/** Avatar and name, for the top of the Store; opens the profile. */
@Composable
internal fun ProfileSummary(profile: Profile, show: () -> Unit) {
    Row(Modifier.clickable(onClick = show).padding(4.dp).testTag("profile-summary"), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Avatar(profile, 32.dp)
        Text(profile.name, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** The signed-in account in full, and this phone's connection (#829). */
@Composable
internal fun ProfileCard(profile: Profile, openUrl: (String) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        Avatar(profile, 64.dp)
        Column {
            Text(profile.name, style = MaterialTheme.typography.titleLarge)
            Text(profile.account, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Labeled("Signed in with", profile.providerName)
            Labeled("User ID", profile.id)
            profile.email?.let { Labeled("Email", it) }
            Labeled("Roles", profile.roles.joinToString(", "))
            if (profile.creator) {
                Labeled("Your apps", "${profile.appCount}")
                TextButton(onClick = { openUrl(Profile.CONSOLE_URL) }, contentPadding = PaddingValues(0.dp)) { Text("Open the console") }
            }
        }
    }
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Labeled("This phone", profile.deviceLabel)
            if (profile.pairedAt > 0) Labeled("Connected", Format.day(profile.pairedAt))
            if (profile.expiresAt > 0) Labeled("Connection expires", Format.day(profile.expiresAt))
        }
    }
}
