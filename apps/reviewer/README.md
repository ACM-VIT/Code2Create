# Code2Create Ops

The native operations app for reviews, VIT ID barcode scans, event QR scans, hall mapping, and support.

## Development

```sh
pnpm --filter @code2create/reviewer start
pnpm --filter @code2create/reviewer typecheck
pnpm --filter @code2create/reviewer config:check
pnpm --filter @code2create/reviewer export:check
```

Copy `.env.example` to `.env.local` for development. The example disables Sentry source-map upload only for the local build; staging and production still require their release credentials. Expo Go is not a reviewer build: camera, encrypted storage, native APNs/FCM registration, and background notification behavior must be tested in a locally compiled app.

With the root `pnpm dev` stack running, compile and open the app without starting a second Metro process:

```sh
pnpm --filter @code2create/reviewer exec expo run:ios --no-bundler
pnpm --filter @code2create/reviewer exec expo run:android --no-bundler
```

Copy `.env.example` to `.env.local` before the first local build. In local development, **Use local event operator** creates an ordinary Better Auth session for the seeded Supreme account and exercises the normal permission checks. The action is rejected outside the full localhost stack. Staging and production show only Google sign-in.

The development client uses Metro, so it does not prove an over-the-air install even when the local Updates Worker is running. Use the signed staging build and staging Updates Worker for the device update rehearsal.

## Local signed builds

No EAS account, project, build, or update service is used. Copy `.env.example` to both `.env.staging.local` and `.env.production.local`, then put only that environment's backend, identifiers, build number, APNs mode, Firebase file, signing values, and update URL in each file. Release commands never load the development `.env.local` or the other environment's file.

Android builds require the release keystore values and the Firebase `google-services.json` path in the selected `.env.staging.local` or `.env.production.local`. Staging produces a signed APK for the phone fleet; production produces the Play Store AAB.

```sh
pnpm --filter @code2create/reviewer build:android:staging
pnpm --filter @code2create/reviewer build:android:production
```

iOS builds use the Apple team already available to local Xcode. Set `C2C_IOS_EXPORT_METHOD` to `development` with `EXPO_PUBLIC_APNS_ENVIRONMENT=development`, or use `ad-hoc` with the production APNs environment for a staging fleet. Production uses `app-store-connect` and the production APNs environment. The build refuses a provisioning/push environment mismatch.

```sh
pnpm --filter @code2create/reviewer build:ios:staging
pnpm --filter @code2create/reviewer build:ios:production
```

Each command requires a clean commit, derives its release ID from that commit, regenerates the native project, refuses a concurrent native build, applies production Android signing without writing passwords into Gradle files, and writes a non-overwriting signed artifact under `outputs/native/`.

`C2C_UPDATES_URL` is compiled into the binary. The embedded certificate in `certs/certificate.pem` verifies every remote manifest or rollback directive. Changing a native dependency or native configuration requires an app-version bump and a new signed fleet build before related JavaScript can be published.

Reviewer paging uses native device tokens. Android messages go directly through Firebase Cloud Messaging; iOS messages go directly through APNs. Push attracts attention only. Convex remains the source of truth for the live page and assignment.
