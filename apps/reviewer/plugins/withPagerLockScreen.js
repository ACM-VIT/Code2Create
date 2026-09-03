const { withAndroidManifest } = require("expo/config-plugins");

/** Configures MainActivity to appear above the Android keyguard. */
module.exports = function withPagerLockScreen(config) {
  return withAndroidManifest(config, (modified) => {
    const application = modified.modResults.manifest.application?.[0];
    const activities = application?.activity ?? [];
    const main = activities.find((activity) => activity.$?.["android:name"] === ".MainActivity");
    if (!main) {
      throw new Error("withPagerLockScreen: MainActivity is not in the manifest.");
    }
    main.$["android:showWhenLocked"] = "true";
    main.$["android:turnScreenOn"] = "true";
    return modified;
  });
};
