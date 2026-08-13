package __C2C_ANDROID_PACKAGE__

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
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

  companion object {
    const val NAME = "Code2CreatePagerAlarm"
  }
}
