import { Config } from '@remotion/cli/config'

Config.setVideoImageFormat('jpeg')
Config.setOverwriteOutput(true)
// Tag the output as BT.709 to prevent black QuickTime playback.
Config.setColorSpace('bt709')
