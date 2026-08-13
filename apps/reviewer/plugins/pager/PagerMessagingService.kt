package __C2C_ANDROID_PACKAGE__

import android.app.KeyguardManager
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import com.google.firebase.messaging.RemoteMessage
import expo.modules.notifications.service.ExpoFirebaseMessagingService

/** Routes substitute pages to a full-screen notification and delegates all other FCM messages. */
class PagerMessagingService : ExpoFirebaseMessagingService() {

  override fun onMessageReceived(remoteMessage: RemoteMessage) {
    if (remoteMessage.data["kind"] != PAGE_KIND) {
      super.onMessageReceived(remoteMessage)
      return
    }
    if (PagerAlarmService.isAppForeground()) {
      PagerAlarmService.stop(this)
      Log.i(TAG, "foreground app owns pager alert")
      return
    }
    val expiresAt = remoteMessage.data["expiresAt"]?.toLongOrNull()
    if (expiresAt == null || expiresAt <= System.currentTimeMillis()) {
      Log.i(TAG, "expired or invalid pager message dropped")
      return
    }
    showPage(remoteMessage, expiresAt)
  }

  private fun showPage(message: RemoteMessage, expiresAt: Long) {
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    val keyguard = getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager

    val launch = packageManager.getLaunchIntentForPackage(packageName)?.apply {
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
      putExtra(PAGE_EXTRA, message.data["pageId"])
    }
    val stop = PendingIntent.getService(
      this,
      STOP_REQUEST,
      Intent(this, PagerAlarmService::class.java).setAction(PagerAlarmService.ACTION_STOP),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val pending = PendingIntent.getActivity(
      this,
      PAGE_REQUEST,
      launch,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    val builder = NotificationCompat.Builder(this, CHANNEL)
      .setSmallIcon(applicationInfo.icon)
      .setContentTitle(message.data["title"] ?: "Substitute request")
      .setContentText(message.data["body"] ?: "A panel needs a reviewer.")
      .setPriority(NotificationCompat.PRIORITY_MAX)
      // CALL enables ringing and lock-screen treatment.
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setAutoCancel(true)
      .setOngoing(true)
      .setContentIntent(pending)
      // Stop ringing when the notification is dismissed.
      .setDeleteIntent(stop)
      .setDefaults(Notification.DEFAULT_ALL)

    // Unlocked devices use the normal heads-up fallback.
    if (keyguard.isKeyguardLocked || Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
      builder.setFullScreenIntent(pending, true)
    }

    manager.notify(PagerAlarmService.PAGE_NOTIFICATION_ID, builder.build())

    // The full-screen notification itself only plays one sound.
    val alarm = Intent(this, PagerAlarmService::class.java)
      .putExtra(PagerAlarmService.EXTRA_TITLE, message.data["title"])
      .putExtra(PagerAlarmService.EXTRA_EXPIRES_AT, expiresAt)
    // Android 12 may reject this after its high-priority-message window closes.
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(alarm)
      else startService(alarm)
      Log.i(TAG, "pager ring requested for " + message.data["pageId"])
    } catch (error: Throwable) {
      Log.e(TAG, "pager ring could not start", error)
    }
  }

  private companion object {
    const val TAG = "PagerService"
    const val PAGE_KIND = "reviewer_substitute_page"
    const val PAGE_EXTRA = "reviewerPageId"
    const val CHANNEL = "reviewer-pages"
    const val PAGE_REQUEST = 4201
    const val STOP_REQUEST = 4204
  }
}
