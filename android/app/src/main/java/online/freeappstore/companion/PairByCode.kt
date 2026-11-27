package online.freeappstore.companion

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.ReaderException
import com.google.zxing.common.HybridBinarizer
import java.net.URI
import java.net.URLDecoder
import java.util.concurrent.Executors
import org.json.JSONObject

/**
 * Pairing by a code (#845), shown by the console's or the desktop app's Add a phone, instead of the browser flow
 * (docs/native-companion.md, QR pairing). A code is a credential until it is used: it stays in memory only.
 */
object PairCode {
    const val QUESTION = "Connect this phone to the account that showed this code?"
    /** The statuses `/native/auth/code` answers for a code that cannot pair, each with its own sentence. */
    val REJECTED = setOf(400, 401, 403, 429)

    /** The code in `freeappstore://native/pair?code=…`, as given (the server ignores case, spaces and dashes); null for anything else. */
    fun fromLink(link: String): String? = try {
        val uri = URI(link.trim())
        if (uri.scheme != "freeappstore" || uri.host != "native" || uri.path != "/pair") null
        else uri.rawQuery?.split('&')?.map { it.split('=', limit = 2) }?.firstOrNull { it[0] == "code" }
            ?.let { URLDecoder.decode(it.getOrElse(1) { "" }, "UTF-8").trim() }?.takeIf { it.isNotEmpty() }
    } catch (_: Exception) { null } // not a URI, or a broken %-escape

    /** `{ code, label }` for `POST /native/auth/code`, the code trimmed; null for a code that cannot be one. */
    fun body(code: String, label: String): JSONObject? =
        code.trim().takeIf { it.isNotEmpty() && it.length <= 64 }?.let { JSONObject().put("code", it).put("label", label.take(80)) }

    /** What a rejected code means to the user. */
    fun failure(status: Int): String = when (status) {
        403 -> "This code expired or was already used. Get a new code and try again."
        429 -> "Too many tries from this network today. Try again tomorrow."
        401 -> "The account that showed this code no longer exists."
        else -> "That is not a FreeAppStore code. Check it and try again."
    }
}

/** Reads QR codes from camera frames with ZXing, on the phone (no remote service, no Play services). */
internal class QrReader {
    private val reader = MultiFormatReader().apply {
        setHints(mapOf(DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE), DecodeHintType.ALSO_INVERTED to true))
    }
    /** The text of a QR code in a luminance (Y) plane, or null when there is none. */
    fun read(luminance: ByteArray, rowStride: Int, width: Int, height: Int): String? = try {
        reader.decodeWithState(BinaryBitmap(HybridBinarizer(PlanarYUVLuminanceSource(luminance, rowStride, height, 0, 0, width, height, false)))).text
    } catch (_: ReaderException) { null } finally { reader.reset() }
}

/** Scan a code / Type the code, next to Sign in. Both ask before pairing; [connect] gets the code only after a yes. */
@Composable
internal fun PairByCode(busy: Boolean, connect: (String) -> Unit) {
    var scanning by remember { mutableStateOf(false) }
    var typing by remember { mutableStateOf(false) }
    var scanned by remember { mutableStateOf<String?>(null) }
    // Wraps rather than squeezing a label at large font sizes.
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        TextButton(onClick = { scanning = true }, enabled = !busy) { Text("Scan a code") }
        TextButton(onClick = { typing = true }, enabled = !busy) { Text("Type the code") }
    }
    if (scanning) ScanCodeDialog({ scanning = false }) { scanning = false; scanned = it }
    scanned?.let { code -> ConfirmPairDialog({ scanned = null }) { scanned = null; connect(code) } }
    if (typing) TypeCodeDialog({ typing = false }) { typing = false; connect(it) }
}

/** Asked for a scanned code and for a `freeappstore://native/pair` link: neither pairs by itself. */
@Composable
internal fun ConfirmPairDialog(dismiss: () -> Unit, connect: () -> Unit) = AlertDialog(onDismissRequest = dismiss,
    title = { Text("Connect this phone?") },
    text = { Text(PairCode.QUESTION) },
    confirmButton = { TextButton(onClick = connect) { Text("Connect") } },
    dismissButton = { TextButton(onClick = dismiss) { Text("Cancel") } })

@Composable
private fun TypeCodeDialog(dismiss: () -> Unit, connect: (String) -> Unit) {
    var code by remember { mutableStateOf("") } // not saveable: the code is never written anywhere
    AlertDialog(onDismissRequest = dismiss,
        title = { Text("Type the code") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("Shown under Add a phone in the console or the desktop app. ${PairCode.QUESTION}")
                // A password field to the keyboard, so it neither suggests nor learns the code; shown in clear.
                OutlinedTextField(code, { code = it.take(64) }, singleLine = true, label = { Text("Code") },
                    keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, keyboardType = KeyboardType.Password))
            }
        },
        confirmButton = { TextButton(onClick = { connect(code) }, enabled = code.isNotBlank()) { Text("Connect") } },
        dismissButton = { TextButton(onClick = dismiss) { Text("Cancel") } })
}

/** The camera, full screen, looking for a FreeAppStore QR code. Anything else is reported and scanning goes on. */
@Composable
private fun ScanCodeDialog(dismiss: () -> Unit, found: (String) -> Unit) {
    val context = LocalContext.current
    var allowed by remember { mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) }
    var problem by remember { mutableStateOf("") }
    var notOurs by remember { mutableStateOf(false) }
    // The camera permission is asked here, only when scanning.
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        allowed = granted
        if (!granted) problem = "Camera access is off. Allow it in Settings > Apps > FreeAppStore > Permissions, or type the code instead."
    }
    LaunchedEffect(Unit) { if (!allowed) ask.launch(Manifest.permission.CAMERA) }
    Dialog(onDismissRequest = dismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize()) {
            Column(Modifier.fillMaxSize().systemBarsPadding().padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Text("Scan a code", style = MaterialTheme.typography.headlineMedium)
                when {
                    problem.isNotEmpty() -> Text(problem, Modifier.weight(1f))
                    allowed -> {
                        QrCamera(Modifier.weight(1f).fillMaxWidth(), { text -> PairCode.fromLink(text)?.let(found) ?: run { notOurs = true } }) { problem = it }
                        Text(if (notOurs) "That is not a FreeAppStore code." else "Point the camera at the code under Add a phone.")
                    }
                    else -> Spacer(Modifier.weight(1f))
                }
                TextButton(onClick = dismiss) { Text("Cancel") }
            }
        }
    }
}

/** CameraX preview plus frame analysis with [QrReader]. Reports each new text once, on the main thread. */
@Composable
private fun QrCamera(modifier: Modifier, read: (String) -> Unit, failed: (String) -> Unit) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    val preview = remember { PreviewView(context) }
    val onRead by rememberUpdatedState(read)
    DisposableEffect(owner) {
        val main = ContextCompat.getMainExecutor(context)
        val frames = Executors.newSingleThreadExecutor()
        val future = ProcessCameraProvider.getInstance(context)
        var disposed = false
        var last: String? = null
        future.addListener({
            if (disposed) return@addListener
            try {
                val provider = future.get()
                val camera = listOf(CameraSelector.DEFAULT_BACK_CAMERA, CameraSelector.DEFAULT_FRONT_CAMERA).firstOrNull { provider.hasCamera(it) }
                    ?: return@addListener failed("No camera is available. Type the code instead.")
                val reader = QrReader()
                val analysis = ImageAnalysis.Builder().setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
                analysis.setAnalyzer(frames) { image ->
                    val text = image.use {
                        val plane = it.planes[0]
                        val bytes = ByteArray(plane.buffer.remaining()).also { b -> plane.buffer.get(b) }
                        reader.read(bytes, plane.rowStride, it.width, it.height)
                    }
                    if (text != null) main.execute { if (!disposed && text != last) { last = text; onRead(text) } }
                }
                provider.unbindAll()
                provider.bindToLifecycle(owner, camera, Preview.Builder().build().also { it.setSurfaceProvider(preview.surfaceProvider) }, analysis)
            } catch (_: Exception) { failed("The camera could not start. Type the code instead.") }
        }, main)
        onDispose {
            disposed = true
            if (future.isDone) runCatching { future.get().unbindAll() }
            frames.shutdown()
        }
    }
    AndroidView({ preview }, modifier)
}
