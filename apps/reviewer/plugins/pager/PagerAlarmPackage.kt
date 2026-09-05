package __C2C_ANDROID_PACKAGE__

import android.app.NotificationManager
import android.os.Build
import android.os.PowerManager
import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

class PagerAlarmPackage : BaseReactPackage() {
  override fun getModule(
    name: String,
    reactContext: ReactApplicationContext,
  ): NativeModule? = if (name == PagerAlarmModule.NAME) PagerAlarmModule(reactContext) else null

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider = ReactModuleInfoProvider {
    mapOf(
      PagerAlarmModule.NAME to ReactModuleInfo(
        PagerAlarmModule.NAME,
        PagerAlarmModule::class.java.name,
        false,
        false,
        false,
        false,
      ),
    )
  }
}

private class PagerAlarmModule(
  reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
  override fun getName(): String = NAME

  @ReactMethod
  fun stop() {
    PagerAlarmService.stop(reactApplicationContext)
  }

  @ReactMethod
  fun getReadiness(promise: Promise) {
    try {
      val notifications = reactApplicationContext.getSystemService(NotificationManager::class.java)
      val power = reactApplicationContext.getSystemService(PowerManager::class.java)
      val result = Arguments.createMap().apply {
        putBoolean("fullScreenAllowed", Build.VERSION.SDK_INT < 34 || notifications.canUseFullScreenIntent())
        putBoolean("batteryUnrestricted", power.isIgnoringBatteryOptimizations(reactApplicationContext.packageName))
      }
      promise.resolve(result)
    } catch (error: Exception) {
      promise.reject("PAGING_READINESS_FAILED", "Android paging settings could not be read.", error)
    }
  }

  companion object {
    const val NAME = "Code2CreatePagerAlarm"
  }
}
