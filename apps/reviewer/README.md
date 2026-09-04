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

## Reviewer venue checks

The Venue entry on the duty home screen and Account opens location setup, departure reporting, and return confirmation. A reviewer registers this phone in Judging, then explicitly allows location. Background checks request a separate Always/Allow all the time permission and use a visible native location indicator or Android foreground-service notification. Foreground checks continue while the app is active if background permission is declined. A reviewer can report leaving without enabling location, or stop checks at any time. Departure calls require their own phone number and explicit consent, separate from substitute-reviewer calls.

Organizers configure the venue center, radius, active window, continuous absence grace, and call delay in **Review setup → Reviewer venue presence**. The event must be live. Suggested form defaults are a 200 m radius, 5 minutes outside before marking Left, and a call after a further 10 minutes. Validate the radius at the actual building before enabling it. Changing configuration invalidates current tracking sessions; reviewers reconnect through Venue.

The app submits one current fix roughly every minute. Convex classifies it using GPS accuracy and a 25 m boundary buffer; uncertain, mocked, old, or out-of-order fixes cannot establish a departure. After 3 minutes without a fresh usable status, location is shown as unavailable and escalation pauses. Lack of location permission, connectivity, or an OS callback is never evidence that someone left. Coordinates are used for classification and are not stored in presence/departure tables or a local travel history. Organizers see status, last check time, a volunteered leaving reason, and notification/call outcomes. Panel clock-in remains a separate state.

An unreported departure triggers the existing native FCM/APNs transport, with up to three bounded push attempts. The call delay starts at the first reminder attempt (or when the reviewer sees the in-app warning). If push is unavailable, the consented phone fallback still runs. The existing voice service receives at most one call delivery per departure; fresh outside evidence and current device, reviewer, event, configuration, grants, and call consent are checked again before dispatch. Reporting departure, returning, disabling tracking, or losing that authority cancels queued escalation. A reported departure remains visible until the reviewer refreshes an accurate inside fix and selects **I'm back at the venue**. Reporting leaving does not arrange a replacement for an active review.

Version 1.1.0 adds native location/task modules and background permissions. Deploy the backend schema/functions and rebuild/sign the fleet locally before publishing JavaScript for this runtime; this feature cannot be installed into the 1.0.1 binary through an update alone. Existing native push and voice provider configuration is reused. No venue checks or calls run until event configuration and reviewer opt-ins are in place.

Before rollout, rehearse on physical Android and iOS phones: grant/deny foreground and background access, walk across the configured boundary for the grace period, receive a push and a consented test call, report leaving before and after the warning, and verify return. Also check a locked screen, force-quit, loss of signal/connectivity, permission revocation, sign-out, and event end. OS background delivery is not guaranteed; stale presence must remain unavailable. See [Expo location platform requirements](https://docs.expo.dev/versions/latest/sdk/location/). Unit tests simulate native callbacks and providers; an Android compilation and JS exports do not replace this device rehearsal.
