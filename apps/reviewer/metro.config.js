const { getPostHogExpoConfig } = require("posthog-react-native/metro");

const config = getPostHogExpoConfig(__dirname);

config.resolver.blockList = [...config.resolver.blockList, /(?:^|[\\/])\.env(?:\.[^\\/]*)?$/];

module.exports = config;
