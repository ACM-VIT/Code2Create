const { getSentryExpoConfig } = require('@sentry/react-native/metro')

const config = getSentryExpoConfig(__dirname)

config.resolver.blockList = [
  ...config.resolver.blockList,
  /(?:^|[\\/])\.env(?:\.[^\\/]*)?$/,
]

module.exports = config
