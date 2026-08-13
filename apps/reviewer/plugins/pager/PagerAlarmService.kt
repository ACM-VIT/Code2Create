package __C2C_ANDROID_PACKAGE__

import android.app.Notification
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import androidx.core.app.ServiceCompat
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import androidx.core.app.NotificationCompat

/** Repeats a page on the Android alarm stream until stopped or expired. */
class PagerAlarmService : Service() {

  private var player: MediaPlayer? = null
  private var vibrator: Vibrator? = null
  private var wakeLock: PowerManager.WakeLock? = null
  private val stopper = Handler(Looper.getMainLooper())

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      cancelPageNotification(this)
      stopSelf()
      return START_NOT_STICKY
    }
    if (isAppForeground()) {
      cancelPageNotification(this)
      stopSelfResult(startId)
      return START_NOT_STICKY
    }

    val expiresAt = intent?.getLongExtra(EXTRA_EXPIRES_AT, 0L) ?: 0L
    val remainingMs = expiresAt - System.currentTimeMillis()
    if (remainingMs <= 0) {
      cancelPageNotification(this)
      stopSelfResult(startId)
      return START_NOT_STICKY
    }

    // Android 14 requires the service type in this call as well as the manifest.
    ServiceCompat.startForeground(
      this,
      FOREGROUND_ID,
      buildForegroundNotification(intent),
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
      } else {
        0
      },
    )
    stopRing()
    stopper.removeCallbacksAndMessages(null)
    // Preserve the notification if the ringtone fails.
    runCatching { ring() }
      .onFailure {
        stopRing()
        Log.e(TAG, "pager could not ring", it)
      }
      .onSuccess { Log.i(TAG, "pager ringing") }

    // Stop at the server-owned page expiry even after delayed delivery.
    stopper.postDelayed(
      {
        cancelPageNotification(this)
        stopSelf()
      },
      remainingMs.coerceAtMost(MAX_RING_MS),
    )
    return START_NOT_STICKY
  }

  private fun buildForegroundNotification(intent: Intent?): Notification {
    val title = intent?.getStringExtra(EXTRA_TITLE) ?: "Substitute request"
    return NotificationCompat.Builder(this, CHANNEL)
      .setSmallIcon(applicationInfo.icon)
      .setContentTitle(title)
      .setContentText("Ringing until you answer")
      .setOngoing(true)
      .build()
  }

  private fun ring() {
    val power = getSystemService(Context.POWER_SERVICE) as PowerManager
    wakeLock = power.newWakeLock(
      PowerManager.PARTIAL_WAKE_LOCK,
      "code2create:pager",
    ).apply { acquire(10 * 60 * 1000L) }

    // Use the bundled pager tone on the alarm stream.
    val tone = Uri.parse("android.resource://" + packageName + "/raw/pager")
    val nextPlayer = MediaPlayer()
    player = nextPlayer
    nextPlayer.apply {
      setAudioAttributes(
        AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_ALARM)
          .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
          .build(),
      )
      setDataSource(applicationContext, tone)
      isLooping = true
      prepare()
      start()
    }

    vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      (getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
    } else {
      @Suppress("DEPRECATION")
      getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
    }
    val pattern = longArrayOf(0, 600, 400, 600, 1_400)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      vibrator?.vibrate(VibrationEffect.createWaveform(pattern, 0))
    } else {
      @Suppress("DEPRECATION")
      vibrator?.vibrate(pattern, 0)
    }
  }

  override fun onDestroy() {
    stopper.removeCallbacksAndMessages(null)
    stopRing()
    ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    super.onDestroy()
  }

  private fun stopRing() {
    runCatching { player?.stop() }
    runCatching { player?.release() }
    player = null
    runCatching { vibrator?.cancel() }
    vibrator = null
    runCatching { if (wakeLock?.isHeld == true) wakeLock?.release() }
    wakeLock = null
  }

  companion object {
    private const val TAG = "PagerAlarm"
    const val ACTION_STOP = "__C2C_ANDROID_PACKAGE__.PAGER_STOP"
    const val EXTRA_EXPIRES_AT = "expiresAt"
    const val EXTRA_TITLE = "title"
    private const val CHANNEL = "reviewer-pages"
    private const val FOREGROUND_ID = 4203
    const val PAGE_NOTIFICATION_ID = 4202
    private const val MAX_RING_MS = 10 * 60 * 1_000L
    @Volatile private var appForeground = false

    fun setAppForeground(foreground: Boolean) {
      appForeground = foreground
    }

    fun isAppForeground(): Boolean = appForeground

    fun stop(context: Context) {
      cancelPageNotification(context)
      context.stopService(Intent(context, PagerAlarmService::class.java))
    }

    private fun cancelPageNotification(context: Context) {
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      manager.cancel(PAGE_NOTIFICATION_ID)
    }
  }
}
