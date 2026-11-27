package online.freeappstore.companion

import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.PowerManager
import java.time.LocalDate
import java.time.LocalTime
import java.util.Locale

/**
 * When Contribute runs (#830), all decided on this phone: the server sets no per-user limits. [off] is the hard stop;
 * otherwise it runs by itself whenever every condition holds (Auto). Defaults never surprise: Wi‑Fi only, charging only,
 * a 40% floor on battery, a pause when hot or while the phone is in use, Balanced CPU, no daily maximum, no quiet hours.
 */
data class ContributeSettings(
    val off: Boolean = false,
    val mobileData: Boolean = false, val mobileCapMb: Int = 500,
    val onBattery: Boolean = false, val minBattery: Int = 40,
    val thermalPause: Boolean = true,
    val slowerInUse: Boolean = false,
    val cpu: Cpu = Cpu.BALANCED,
    /** 0: no maximum. */
    val dailyJobs: Int = 0, val dailyMinutes: Int = 0,
    /** Minutes of the day; the window may wrap midnight. */
    val quietHours: Boolean = false, val quietFrom: Int = 22 * 60, val quietTo: Int = 7 * 60,
    /** The overnight summary notification (#844). */
    val summary: Boolean = true,
) {
    /** sherpa-onnx threads, and a rest after each sentence as a share of the time it took. */
    enum class Cpu(val label: String, val threads: Int, val rest: Double) {
        LIGHT("Light", 1, 1.0), BALANCED("Balanced", 2, 0.25), FULL("Full", 4, 0.0)
    }
}

/** What the phone is doing now, as [ContributeConditions] needs it. [battery] is null when unknown. */
data class DeviceState(
    val connected: Boolean, val unmetered: Boolean, val plugged: Boolean, val battery: Int?, val thermal: Int, val inUse: Boolean,
    val minuteOfDay: Int, val mobileBytes: Long, val jobsToday: Int, val msToday: Long,
)

/** Why Contribute is not running now: [code] for the log, [text] for the status card. */
data class Hold(val code: String, val text: String) {
    /**
     * The #813 end reason of a job this stopped part-way. Each is an interruption to the server (#841), so the job is
     * given back to this account rather than lost.
     */
    val reason: String get() = when (code) {
        "unplugged", "battery" -> "unplugged"
        "thermal" -> "thermal"
        "offline", "metered", "data_cap" -> "network"
        else -> "user_stop"
    }
}

object ContributeConditions {
    const val OFF = "Contribute is off. It will not start again until you turn it on."
    /** A job this far through when a condition fails is finished; anything less is stopped and given back. */
    const val NEARLY_DONE = 0.8
    /** `PowerManager.THERMAL_STATUS_MODERATE`: pause from here up. */
    const val THERMAL_PAUSE = 2

    /**
     * The first condition that fails, or null when Contribute may run. [claiming]: about to claim a job, which needs a
     * connection; a job in hand does not (its upload retries).
     */
    fun hold(s: ContributeSettings, d: DeviceState, claiming: Boolean): Hold? = when {
        s.off -> Hold("off", OFF)
        s.quietHours && within(d.minuteOfDay, s.quietFrom, s.quietTo) -> Hold("quiet_hours", "Quiet hours until ${clock(s.quietTo)}.")
        s.dailyJobs > 0 && d.jobsToday >= s.dailyJobs -> Hold("daily_max", "Daily maximum reached: ${s.dailyJobs} jobs.")
        s.dailyMinutes > 0 && d.msToday >= s.dailyMinutes * 60_000L -> Hold("daily_max", "Daily maximum reached: ${s.dailyMinutes} min.")
        claiming && !d.connected -> Hold("offline", "No connection.")
        d.connected && !d.unmetered && !s.mobileData -> Hold("metered", "On mobile data. It runs on Wi‑Fi only.")
        d.connected && !d.unmetered && d.mobileBytes >= s.mobileCapMb * 1_000_000L ->
            Hold("data_cap", "Mobile data allowance used: ${d.mobileBytes / 1_000_000} of ${s.mobileCapMb} MB this month.")
        !d.plugged && !s.onBattery -> Hold("unplugged", "Not plugged in. It runs while charging.")
        !d.plugged && d.battery != null && d.battery < s.minBattery -> Hold("battery", "Battery ${d.battery}% (min ${s.minBattery}%).")
        s.thermalPause && d.thermal >= THERMAL_PAUSE -> Hold("thermal", "The phone is hot.")
        d.inUse && !s.slowerInUse -> Hold("in_use", "Phone in use.")
        else -> null
    }
    /** Whether a job [done] of the way through (0 to 1) finishes despite a failed condition. */
    fun finishes(done: Double) = done >= NEARLY_DONE
    /** Whether the voice model (#731) may download now: on Wi‑Fi, or within the month's mobile allowance. */
    fun modelFits(s: ContributeSettings, d: DeviceState) = d.unmetered || d.mobileBytes + KokoroModel.DOWNLOAD_BYTES <= s.mobileCapMb * 1_000_000L
    /** The rest after a sentence that took [synthMs]: the CPU setting's, at least as long as the sentence when [slower]. */
    fun restMs(synthMs: Long, cpu: ContributeSettings.Cpu, slower: Boolean): Long = (synthMs * maxOf(cpu.rest, if (slower) 1.0 else 0.0)).toLong()
    /** Whether [minute] is in the window from [from] to [to] (minutes of the day), which may wrap midnight. */
    fun within(minute: Int, from: Int, to: Int) = if (from <= to) minute in from until to else minute >= from || minute < to
    fun clock(minute: Int) = "%02d:%02d".format(Locale.ROOT, minute / 60, minute % 60)
}

/**
 * The phone now, for [ContributeConditions]: the active network, `EXTRA_PLUGGED` and the level from the sticky battery
 * broadcast, `PowerManager` thermal status, in use (screen on and unlocked), and this phone's own counts: mobile data this
 * month, jobs uploaded today and time spent today, plus [runMs] of the run in progress.
 */
internal fun contributeDevice(context: Context, local: LocalStore, runMs: Long = 0): DeviceState {
    val connectivity = context.getSystemService(ConnectivityManager::class.java)
    val caps = connectivity.getNetworkCapabilities(connectivity.activeNetwork)
    val battery = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
    val level = battery?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
    val scale = battery?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
    val power = context.getSystemService(PowerManager::class.java)
    val today = LocalDate.now()
    return DeviceState(
        connected = caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true,
        unmetered = caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) == true,
        plugged = (battery?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0) != 0,
        battery = if (level >= 0 && scale > 0) level * 100 / scale else null,
        thermal = power.currentThermalStatus,
        inUse = power.isInteractive && !context.getSystemService(KeyguardManager::class.java).isKeyguardLocked,
        minuteOfDay = LocalTime.now().let { it.hour * 60 + it.minute },
        mobileBytes = local.mobileBytes(),
        jobsToday = local.uploadedSince(today.atStartOfDay(java.time.ZoneId.systemDefault()).toInstant().toEpochMilli()),
        msToday = local.runMsToday() + runMs,
    )
}
