/* eslint-disable import/first -- React Native must be mocked before the module loads. */
import { beforeEach, describe, expect, test, vi } from 'vitest'

const alarm = vi.hoisted(() => ({
  nativeStop: vi.fn(),
  vibrate: vi.fn(),
  cancel: vi.fn(),
}))

vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  TurboModuleRegistry: {
    get: () => ({ stop: alarm.nativeStop }),
  },
  Vibration: {
    vibrate: alarm.vibrate,
    cancel: alarm.cancel,
  },
}))

import { startPagerAlarm, stopPagerAlarm } from './pager-alarm'

describe('pager alarm', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    stopPagerAlarm()
    alarm.nativeStop.mockClear()
    alarm.vibrate.mockClear()
    alarm.cancel.mockClear()
  })

  test('stops the native alarm even when JavaScript did not start one', () => {
    stopPagerAlarm()

    expect(alarm.nativeStop).toHaveBeenCalledOnce()
    expect(alarm.cancel).toHaveBeenCalledOnce()
  })

  test('starts one vibration beat and releases both alarm implementations', () => {
    startPagerAlarm()
    startPagerAlarm()
    vi.advanceTimersByTime(3_000)

    expect(alarm.vibrate).toHaveBeenCalledTimes(2)

    stopPagerAlarm()
    vi.advanceTimersByTime(3_000)

    expect(alarm.vibrate).toHaveBeenCalledTimes(2)
    expect(alarm.cancel).toHaveBeenCalledOnce()
    expect(alarm.nativeStop).toHaveBeenCalledOnce()
  })
})
