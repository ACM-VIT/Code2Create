import { readEncryptionKeyConfiguration } from './keyEnvironment.ts'

const configuration = readEncryptionKeyConfiguration(process.env)

console.log(
  JSON.stringify(
    {
      valid: true,
      attendance: {
        currentVersion: configuration.attendanceCurrentVersion,
        previousVersion: configuration.attendancePreviousVersion,
      },
      provider: {
        currentVersion: configuration.providerCurrentVersion,
        previousVersion: configuration.providerPreviousVersion,
      },
    },
    null,
    2,
  ),
)
