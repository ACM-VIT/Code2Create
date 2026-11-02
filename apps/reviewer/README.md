# Code2Create Ops

The native operations app for reviews, VIT ID barcode scans, event QR scans, and support.

## Development

```sh
pnpm --filter @code2create/reviewer start
pnpm --filter @code2create/reviewer typecheck
pnpm --filter @code2create/reviewer config:check
pnpm --filter @code2create/reviewer export:check
```

Copy `.env.example` to `.env.local` for development. PostHog error capture runs locally, while source-map and native-symbol uploads require release credentials only for signed staging and production builds. Expo Go is not a reviewer build: camera, encrypted storage, native APNs/FCM registration, and background notification behavior must be tested in a locally compiled app.

With the root `pnpm dev` stack running, compile and open the app without starting a second Metro process:

```sh
pnpm --filter @code2create/reviewer exec expo run:ios --no-bundler
pnpm --filter @code2create/reviewer exec expo run:android --no-bundler
```

Copy `.env.example` to `.env.local` before the first local build. Development uses the same Google sign-in, invitation, scoped-grant, device-registration, and panel-assignment paths as staging and production. It creates no synthetic identity or assignment.

The development client uses Metro, so it does not prove an over-the-air install even when the local Updates Worker is running. Use the signed staging build and staging Updates Worker for the device update rehearsal.

## Washroom outings

In Presence, choose Coming in or Going out and a movement reason before scanning. The selection stays ready for the next person. Meals, organizer tasks and other general movements have no outing capacity requirement or return cutoff; Coming in also works when an earlier departure was not recorded. Staffed check-in and participant eligibility remain required.

Set the maximum simultaneous short breaks in Ops → Check-in plan → Washroom outings. Only a departure explicitly marked Washroom / short break checks the permission shown on the participant dashboard and starts the 15-minute outing. A free slot grants permission immediately; excess requests wait. Short-break departures require a live connection. The matching return scan releases capacity; overdue participants remain counted and can receive the Sarvam return reminder. General departures never trigger that reminder.

Rehearse with a small capacity: fill the slots, request one more outing, scan that waiting participant, return one permitted participant, and verify the next person is granted permission. Also check unused permission expiry, a late return, duplicate scans, and a lost scan response.

## Local signed builds

No EAS account, project, build, or update service is used. Copy `.env.example` to both `.env.staging.local` and `.env.production.local`, then put only that environment's backend, identifiers, build number, APNs mode, Firebase file, signing values, and update URL in each file. Release commands never load the development `.env.local` or the other environment's file.

Android builds require the release keystore values and the Firebase `google-services.json` path in the selected `.env.staging.local` or `.env.production.local`. Staging produces a signed APK for the phone fleet; production produces the Play Store AAB. Use the production APK command when a directly installable artifact must target production services.

```sh
pnpm --filter @code2create/reviewer build:android:staging
pnpm --filter @code2create/reviewer build:android:production
pnpm --filter @code2create/reviewer build:android:production:apk
```

iOS builds use the Apple team already available to local Xcode. Set `C2C_IOS_EXPORT_METHOD` to `development` with `EXPO_PUBLIC_APNS_ENVIRONMENT=development`, or use `ad-hoc` with the production APNs environment for a staging fleet. Production uses `app-store-connect` and the production APNs environment. The build refuses a provisioning/push environment mismatch.

```sh
pnpm --filter @code2create/reviewer build:ios:staging
pnpm --filter @code2create/reviewer build:ios:production
```

Each command requires a clean commit, derives its release ID from that commit, regenerates the native project, refuses a concurrent native build, applies production Android signing without writing passwords into Gradle files, and writes a non-overwriting signed artifact under `outputs/native/`.

`C2C_UPDATES_URL` is compiled into the binary. The embedded certificate in `certs/certificate.pem` verifies every remote manifest or rollback directive. Changing a native dependency or native configuration requires an app-version bump and a new signed fleet build before related JavaScript can be published.

Reviewer paging uses native device tokens. Android messages go directly through Firebase Cloud Messaging; iOS messages go directly through APNs. Push attracts attention only. Convex remains the source of truth for the live page and assignment.

The app reads Android full-screen alert and battery-exemption settings natively. Camera and paging checks refresh after permission prompts and when returning from Settings on both Android and iOS. Notification permission and push-token registration are shown separately, and optional call-consent failures stay inside paging setup.
