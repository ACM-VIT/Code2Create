import {
  copyFile,
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { z } from "zod";

const reviewerDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(reviewerDirectory, "../..");
const buildLockPath = join(reviewerDirectory, ".native-build.lock");

const platform = z.enum(["android", "ios"]).parse(process.argv[2]);
const environment = z.enum(["staging", "production"]).parse(process.argv[3]);
loadEnvironmentFile(join(reviewerDirectory, `.env.${environment}.local`));

async function build(
  selectedPlatform: "android" | "ios",
  selectedEnvironment: "staging" | "production",
) {
  await requireCleanGitTree();
  const releaseId = (await runAndCapture("git", ["rev-parse", "HEAD"], repositoryRoot)).trim();
  const appBuild = positiveIntegerEnvironmentValue("EXPO_PUBLIC_APP_BUILD");
  const appConfig = appJsonSchema.parse(
    JSON.parse(await readFile(join(reviewerDirectory, "app.json"), "utf8")),
  );
  const platformConfiguration =
    selectedPlatform === "android"
      ? readAndroidBuildConfiguration(selectedEnvironment)
      : readIosBuildConfiguration(selectedEnvironment);
  const outputDirectory = join(repositoryRoot, "outputs/native", selectedPlatform);
  await mkdir(outputDirectory, { recursive: true });

  const nativeEnvironment = {
    ...process.env,
    NODE_ENV: "production" as const,
    C2C_NATIVE_BUILD: "true",
    C2C_NATIVE_PLATFORM: selectedPlatform,
    EXPO_PUBLIC_DEPLOYMENT_ENVIRONMENT: selectedEnvironment,
    EXPO_PUBLIC_RELEASE_ID: releaseId,
    ...(platformConfiguration.platform === "android"
      ? {
          C2C_ANDROID_KEYSTORE_PATH: platformConfiguration.keystorePath,
          C2C_ANDROID_GOOGLE_SERVICES_FILE: platformConfiguration.googleServicesPath,
        }
      : {
          C2C_IOS_TEAM_ID: platformConfiguration.teamId,
          C2C_IOS_EXPORT_METHOD: platformConfiguration.method,
          EXPO_PUBLIC_APNS_ENVIRONMENT: platformConfiguration.apnsEnvironment,
        }),
  };
  await run(
    "pnpm",
    ["exec", "expo", "prebuild", "--platform", selectedPlatform, "--clean", "--no-install"],
    reviewerDirectory,
    nativeEnvironment,
  );
  if (selectedPlatform === "ios") {
    await run("pod", ["install"], join(reviewerDirectory, "ios"), nativeEnvironment);
  }

  const artifact =
    platformConfiguration.platform === "android"
      ? await buildAndroid(nativeEnvironment, platformConfiguration)
      : await buildIos(nativeEnvironment, platformConfiguration);
  const extension = artifact.endsWith(".aab") ? "aab" : artifact.endsWith(".apk") ? "apk" : "ipa";
  const outputPath = join(
    outputDirectory,
    `code2create-ops-${selectedEnvironment}-${appConfig.expo.version}-${appBuild}-${releaseId.slice(0, 12)}.${extension}`,
  );
  try {
    await copyFile(artifact, outputPath, constants.COPYFILE_EXCL);
  } finally {
    if (platformConfiguration.platform === "ios") await unlink(artifact);
  }
  console.log(`Built signed ${selectedPlatform} release: ${outputPath}`);
}

function readAndroidBuildConfiguration(
  selectedEnvironment: "staging" | "production",
): AndroidBuildConfiguration {
  const keystorePath = resolve(requiredEnvironmentValue("C2C_ANDROID_KEYSTORE_PATH"));
  if (!existsSync(keystorePath)) throw new Error(`Android keystore not found: ${keystorePath}`);
  requiredEnvironmentValue("C2C_ANDROID_KEYSTORE_PASSWORD");
  requiredEnvironmentValue("C2C_ANDROID_KEY_ALIAS");
  requiredEnvironmentValue("C2C_ANDROID_KEY_PASSWORD");
  const googleServicesPath = resolve(requiredEnvironmentValue("C2C_ANDROID_GOOGLE_SERVICES_FILE"));
  if (!existsSync(googleServicesPath)) {
    throw new Error(`Firebase Android config not found: ${googleServicesPath}`);
  }
  const defaultArtifact = selectedEnvironment === "production" ? "aab" : "apk";
  const artifact = androidArtifactSchema.parse(process.argv[4] ?? defaultArtifact);
  return { platform: "android", keystorePath, googleServicesPath, artifact };
}

async function buildAndroid(
  nativeEnvironment: NodeJS.ProcessEnv,
  configuration: AndroidBuildConfiguration,
) {
  const gradlePath = join(reviewerDirectory, "android/app/build.gradle");
  const original = await readFile(gradlePath, "utf8");
  const configured = configureAndroidReleaseSigning(original);
  await writeFile(gradlePath, configured, "utf8");
  await configureAndroidGradleMemory();

  const task = configuration.artifact === "aab" ? "app:bundleRelease" : "app:assembleRelease";
  await run(
    "./gradlew",
    [task, "--no-daemon"],
    join(reviewerDirectory, "android"),
    nativeEnvironment,
  );
  return configuration.artifact === "aab"
    ? join(reviewerDirectory, "android/app/build/outputs/bundle/release/app-release.aab")
    : join(reviewerDirectory, "android/app/build/outputs/apk/release/app-release.apk");
}

async function configureAndroidGradleMemory() {
  const gradlePropertiesPath = join(reviewerDirectory, "android/gradle.properties");
  const original = await readFile(gradlePropertiesPath, "utf8");
  const configured = original.replace(
    /^org\.gradle\.jvmargs=.*$/mu,
    "org.gradle.jvmargs=-Xmx4096m -XX:MaxMetaspaceSize=1024m",
  );
  if (configured === original) {
    throw new Error("The generated Android project does not declare org.gradle.jvmargs.");
  }
  await writeFile(gradlePropertiesPath, configured, "utf8");
}

function configureAndroidReleaseSigning(buildGradle: string) {
  const signingMarker = `    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }`;
  const releaseSigning = `    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
        release {
            storeFile file(System.getenv('C2C_ANDROID_KEYSTORE_PATH'))
            storePassword System.getenv('C2C_ANDROID_KEYSTORE_PASSWORD')
            keyAlias System.getenv('C2C_ANDROID_KEY_ALIAS')
            keyPassword System.getenv('C2C_ANDROID_KEY_PASSWORD')
        }
    }`;
  const debugReleaseMarker = `            // Caution! In production, you need to generate your own keystore file.
            // see https://reactnative.dev/docs/signed-apk-android.
            signingConfig signingConfigs.debug`;
  const productionReleaseSigning = "            signingConfig signingConfigs.release";

  if (!buildGradle.includes(signingMarker) || !buildGradle.includes(debugReleaseMarker)) {
    throw new Error("The generated Android project no longer matches the release-signing patch.");
  }
  return buildGradle
    .replace(signingMarker, releaseSigning)
    .replace(debugReleaseMarker, productionReleaseSigning);
}

function readIosBuildConfiguration(
  selectedEnvironment: "staging" | "production",
): IosBuildConfiguration {
  const teamId = requiredEnvironmentValue("C2C_IOS_TEAM_ID").toUpperCase();
  if (!/^[A-Z0-9]{10}$/u.test(teamId)) throw new Error("C2C_IOS_TEAM_ID is invalid.");
  const bundleIdentifier = requiredEnvironmentValue("C2C_IOS_BUNDLE_IDENTIFIER");
  const method = iosExportMethodSchema.parse(requiredEnvironmentValue("C2C_IOS_EXPORT_METHOD"));
  const profileSpecifier = process.env.C2C_IOS_PROVISIONING_PROFILE_SPECIFIER?.trim() || null;
  const apnsEnvironment = apnsEnvironmentSchema.parse(
    requiredEnvironmentValue("EXPO_PUBLIC_APNS_ENVIRONMENT"),
  );
  if (selectedEnvironment === "production" && method !== "app-store-connect") {
    throw new Error("Production iOS builds must use the app-store-connect export method.");
  }
  const expectedApnsEnvironment = method === "development" ? "development" : "production";
  if (apnsEnvironment !== expectedApnsEnvironment) {
    throw new Error(
      `${method} iOS exports require EXPO_PUBLIC_APNS_ENVIRONMENT=${expectedApnsEnvironment}.`,
    );
  }
  if (selectedEnvironment === "production" && !profileSpecifier) {
    throw new Error("Set C2C_IOS_PROVISIONING_PROFILE_SPECIFIER for production iOS builds.");
  }
  return {
    platform: "ios",
    teamId,
    bundleIdentifier,
    method,
    profileSpecifier,
    apnsEnvironment,
  };
}

async function buildIos(
  nativeEnvironment: NodeJS.ProcessEnv,
  configuration: IosBuildConfiguration,
) {
  const { teamId, bundleIdentifier, method, profileSpecifier } = configuration;

  const iosDirectory = join(reviewerDirectory, "ios");
  const workspace = (await readdir(iosDirectory)).find((entry) => entry.endsWith(".xcworkspace"));
  if (!workspace) throw new Error("Expo prebuild did not create an iOS workspace.");

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "code2create-ios-build-"));
  const archivePath = join(temporaryDirectory, "Code2CreateOps.xcarchive");
  const exportPath = join(temporaryDirectory, "export");
  const exportOptionsPath = join(temporaryDirectory, "ExportOptions.plist");
  try {
    await writeFile(
      exportOptionsPath,
      exportOptionsPlist(teamId, bundleIdentifier, method, profileSpecifier),
      "utf8",
    );
    const archiveSigningArguments = profileSpecifier
      ? [
          `DEVELOPMENT_TEAM=${teamId}`,
          "CODE_SIGN_STYLE=Manual",
          `CODE_SIGN_IDENTITY=${method === "development" ? "Apple Development" : "Apple Distribution"}`,
          `PROVISIONING_PROFILE_SPECIFIER=${profileSpecifier}`,
        ]
      : ["-allowProvisioningUpdates"];
    await run(
      "xcodebuild",
      [
        "-workspace",
        join(iosDirectory, workspace),
        "-scheme",
        "Code2CreateOps",
        "-configuration",
        "Release",
        "-destination",
        "generic/platform=iOS",
        "-archivePath",
        archivePath,
        ...archiveSigningArguments,
        "archive",
      ],
      reviewerDirectory,
      nativeEnvironment,
    );
    await run(
      "xcodebuild",
      [
        "-exportArchive",
        "-archivePath",
        archivePath,
        "-exportPath",
        exportPath,
        "-exportOptionsPlist",
        exportOptionsPath,
        ...(profileSpecifier ? [] : ["-allowProvisioningUpdates"]),
      ],
      reviewerDirectory,
      nativeEnvironment,
    );
    const ipaFiles = (await readdir(exportPath)).filter((entry) => entry.endsWith(".ipa"));
    if (ipaFiles.length !== 1 || !ipaFiles[0]) {
      throw new Error("The iOS export did not produce exactly one IPA.");
    }
    const retainedPath = join(repositoryRoot, "outputs/native/.staging", basename(ipaFiles[0]));
    await mkdir(dirname(retainedPath), { recursive: true });
    await copyFile(join(exportPath, ipaFiles[0]), retainedPath);
    return retainedPath;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function exportOptionsPlist(
  teamId: string,
  bundleIdentifier: string,
  method: z.infer<typeof iosExportMethodSchema>,
  profileSpecifier: string | null,
) {
  const manualSigning = profileSpecifier
    ? `
  <key>signingCertificate</key>
  <string>${method === "development" ? "Apple Development" : "Apple Distribution"}</string>
  <key>provisioningProfiles</key>
  <dict>
    <key>${bundleIdentifier}</key>
    <string>${escapeXmlText(profileSpecifier)}</string>
  </dict>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>${method}</string>
  <key>teamID</key>
  <string>${teamId}</string>
  <key>signingStyle</key>
  <string>${profileSpecifier ? "manual" : "automatic"}</string>${manualSigning}
  <key>stripSwiftSymbols</key>
  <true/>
  <key>uploadSymbols</key>
  <true/>
</dict>
</plist>
`;
}

function escapeXmlText(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function withBuildLock(operation: () => Promise<void>) {
  let lock;
  try {
    lock = await open(buildLockPath, "wx");
  } catch {
    throw new Error("Another reviewer native build is already running.");
  }
  try {
    await lock.writeFile(`${process.pid}\n`);
    await operation();
  } finally {
    await lock.close();
    await unlink(buildLockPath);
  }
}

function positiveIntegerEnvironmentValue(name: string) {
  const value = requiredEnvironmentValue(name);
  if (!/^\d+$/u.test(value)) throw new Error(`${name} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function requiredEnvironmentValue(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name}.`);
  return value;
}

function loadEnvironmentFile(path: string) {
  if (existsSync(path)) process.loadEnvFile(path);
}

async function requireCleanGitTree() {
  const status = await runAndCapture("git", ["status", "--porcelain"], repositoryRoot);
  if (status.trim())
    throw new Error("Commit the working tree before producing a signed native build.");
}

async function run(command: string, args: string[], cwd: string, environment: NodeJS.ProcessEnv) {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, env: environment, stdio: "inherit" });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${command} failed with ${signal ?? `exit code ${code}`}.`));
    });
  });
}

async function runAndCapture(command: string, args: string[], cwd: string) {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "inherit"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise(Buffer.concat(chunks).toString("utf8"));
      else rejectPromise(new Error(`${command} failed with ${signal ?? `exit code ${code}`}.`));
    });
  });
}

const iosExportMethodSchema = z.enum(["app-store-connect", "ad-hoc", "development"]);
const apnsEnvironmentSchema = z.enum(["development", "production"]);
const androidArtifactSchema = z.enum(["apk", "aab"]);

type AndroidBuildConfiguration = {
  platform: "android";
  keystorePath: string;
  googleServicesPath: string;
  artifact: z.infer<typeof androidArtifactSchema>;
};

type IosBuildConfiguration = {
  platform: "ios";
  teamId: string;
  bundleIdentifier: string;
  method: z.infer<typeof iosExportMethodSchema>;
  profileSpecifier: string | null;
  apnsEnvironment: z.infer<typeof apnsEnvironmentSchema>;
};

const appJsonSchema = z.object({
  expo: z.object({
    version: z.string().min(1),
  }),
});

await withBuildLock(() => build(platform, environment));
