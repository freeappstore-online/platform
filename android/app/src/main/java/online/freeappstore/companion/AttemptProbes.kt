package online.freeappstore.companion

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.os.Debug
import android.os.PowerManager
import android.os.Process

/** `PowerManager.THERMAL_STATUS_*` by value, as #827's `thermalStart`/`thermalEnd` name them. */
private val THERMAL = listOf("none", "light", "moderate", "severe", "critical", "emergency", "shutdown")

/**
 * The phone's side of an attempt record (#827). Battery and charging come from the sticky `ACTION_BATTERY_CHANGED`
 * (charging includes full on the charger), thermal from `PowerManager.currentThermalStatus`, the network from the
 * active network's transport, background from this process's importance (anything below a visible activity, which
 * includes running as a foreground service), CPU from `Process.getElapsedCpuTime` and memory as the native heap
 * allocated (where sherpa-onnx's buffers live) plus the Java heap in use.
 */
internal fun androidProbes(context: Context, stopReason: () -> String): DeviceProbes {
    val power = context.getSystemService(PowerManager::class.java)
    val connectivity = context.getSystemService(ConnectivityManager::class.java)
    return DeviceProbes(
        appVersion = runCatching { context.packageManager.getPackageInfo(context.packageName, 0).let { "${it.versionName} (${it.longVersionCode})" } }.getOrNull(),
        os = "Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})", device = "${Build.MANUFACTURER} ${Build.MODEL}",
        reading = {
            val battery = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            val level = battery?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
            val scale = battery?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
            val status = battery?.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
            DeviceReading(if (level >= 0 && scale > 0) level * 100 / scale else null,
                battery?.let { status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL },
                THERMAL.getOrNull(power.currentThermalStatus))
        },
        network = {
            val caps = connectivity.getNetworkCapabilities(connectivity.activeNetwork)
            when {
                caps == null -> "none"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
                else -> "other"
            }
        },
        background = {
            ActivityManager.RunningAppProcessInfo().also(ActivityManager::getMyMemoryState).importance >
                ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
        },
        cpuMs = Process::getElapsedCpuTime,
        memMb = { Runtime.getRuntime().let { (Debug.getNativeHeapAllocatedSize() + it.totalMemory() - it.freeMemory()) / 1_048_576 } },
        stopReason = stopReason,
    )
}
