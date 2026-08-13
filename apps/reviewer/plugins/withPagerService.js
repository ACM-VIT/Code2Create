const fs = require('node:fs')
const path = require('node:path')
const {
  withAndroidManifest,
  withAppBuildGradle,
  withDangerousMod,
} = require('expo/config-plugins')

// expo-notifications keeps this dependency off the app compile classpath.
const MESSAGING = "implementation 'com.google.firebase:firebase-messaging:25.0.1'"

// A ringing page uses the foreground-service specialUse subtype.
const FOREGROUND_PERMISSIONS = [
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_SPECIAL_USE',
]
const EXPO_SERVICE = 'expo.modules.notifications.service.ExpoFirebaseMessagingService'

module.exports = function withPagerService(config) {
  const copied = withDangerousMod(config, [
    'android',
    (modified) => {
      const packageName = requireAndroidPackage(modified)
      const packageDirectory = packageName.replaceAll('.', '/')

      // Copy the tone into Android resources for use without JavaScript.
      const tone = path.join(
        modified.modRequest.platformProjectRoot,
        'app/src/main/res/raw/pager.wav',
      )
      fs.mkdirSync(path.dirname(tone), { recursive: true })
      fs.copyFileSync(
        path.join(modified.modRequest.projectRoot, 'assets/sounds/pager.wav'),
        tone,
      )

      for (const file of [
        'PagerMessagingService.kt',
        'PagerAlarmService.kt',
        'PagerAlarmPackage.kt',
      ]) {
        const source = path.join(__dirname, 'pager', file)
        const destination = path.join(
          modified.modRequest.platformProjectRoot,
          `app/src/main/java/${packageDirectory}`,
          file,
        )
        fs.mkdirSync(path.dirname(destination), { recursive: true })
        const template = fs.readFileSync(source, 'utf8')
        fs.writeFileSync(
          destination,
          template.replaceAll('__C2C_ANDROID_PACKAGE__', packageName),
        )
      }
      const activity = path.join(
        modified.modRequest.platformProjectRoot,
        `app/src/main/java/${packageDirectory}/MainActivity.kt`,
      )
      const source = fs.readFileSync(activity, 'utf8')
      fs.writeFileSync(activity, addPagerLifecycle(source))

      const application = path.join(
        modified.modRequest.platformProjectRoot,
        `app/src/main/java/${packageDirectory}/MainApplication.kt`,
      )
      const applicationSource = fs.readFileSync(application, 'utf8')
      if (!applicationSource.includes('add(PagerAlarmPackage())')) {
        const patched = applicationSource.replace(
          /PackageList\(this\)\.packages\.apply \{/,
          (match) => `${match}\n          add(PagerAlarmPackage())`,
        )
        if (patched === applicationSource) {
          throw new Error('withPagerService: MainApplication did not match the expected shape.')
        }
        fs.writeFileSync(application, patched)
      }
      return modified
    },
  ])

  const compiled = withAppBuildGradle(copied, (modified) => {
    if (modified.modResults.contents.includes(MESSAGING)) return modified
    modified.modResults.contents = modified.modResults.contents.replace(
      /dependencies\s*\{/,
      (match) => `${match}\n    ${MESSAGING}`,
    )
    return modified
  })

  return withAndroidManifest(compiled, (modified) => {
    const packageName = requireAndroidPackage(modified)
    const serviceName = `${packageName}.PagerMessagingService`
    const alarmServiceName = `${packageName}.PagerAlarmService`
    const application = modified.modResults.manifest.application?.[0]
    if (!application) throw new Error('withPagerService: no <application> in the manifest.')
    application.service = application.service ?? []

    const already = application.service.findIndex(
      (service) => service.$?.['android:name'] === serviceName,
    )
    if (already !== -1) application.service.splice(already, 1)

    const entry = {
      $: { 'android:name': serviceName, 'android:exported': 'false' },
      'intent-filter': [
        { action: [{ $: { 'android:name': 'com.google.firebase.MESSAGING_EVENT' } }] },
      ],
    }

    // The first matching FCM service receives the message.
    const expoAt = application.service.findIndex(
      (service) => service.$?.['android:name'] === EXPO_SERVICE,
    )
    if (expoAt === -1) application.service.unshift(entry)
    else application.service.splice(expoAt, 0, entry)

    const alarmAt = application.service.findIndex(
      (service) => service.$?.['android:name'] === alarmServiceName,
    )
    if (alarmAt !== -1) application.service.splice(alarmAt, 1)
    application.service.push({
      $: {
        'android:name': alarmServiceName,
        'android:exported': 'false',
        'android:foregroundServiceType': 'specialUse',
      },
      property: [
        {
          $: {
            'android:name': 'android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE',
            'android:value': 'A reviewer page rings until it is answered.',
          },
        },
      ],
    })

    const manifest = modified.modResults.manifest
    manifest['uses-permission'] = manifest['uses-permission'] ?? []
    for (const name of FOREGROUND_PERMISSIONS) {
      const held = manifest['uses-permission'].some(
        (entry) => entry.$?.['android:name'] === name,
      )
      if (!held) manifest['uses-permission'].push({ $: { 'android:name': name } })
    }

    return modified
  })
}

function requireAndroidPackage(config) {
  const packageName = config.android?.package
  if (!packageName || !/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u.test(packageName)) {
    throw new Error(
      `withPagerService: android.package must be a lowercase reverse-DNS name; received ${JSON.stringify(packageName)}.`,
    )
  }
  return packageName
}

function addPagerLifecycle(source) {
  if (source.includes('PagerAlarmService.setAppForeground(true)')) return source

  const lifecycle = `  override fun onResume() {
    super.onResume()
    PagerAlarmService.setAppForeground(true)
    PagerAlarmService.stop(this)
  }

  override fun onPause() {
    PagerAlarmService.setAppForeground(false)
    super.onPause()
  }
`
  const oldResume = `  override fun onResume() {
    super.onResume()
    PagerAlarmService.stop(this)
  }
`
  const patched = source.includes(oldResume)
    ? source.replace(oldResume, lifecycle)
    : source.replace(
        /class MainActivity : ReactActivity\(\) \{/,
        (match) => `${match}\n${lifecycle}`,
      )
  if (patched === source) {
    throw new Error('withPagerService: MainActivity did not match the expected shape.')
  }
  return patched
}
