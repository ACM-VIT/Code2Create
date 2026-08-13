import { ConvexError } from 'convex/values'
import { describe, expect, test } from 'vitest'

import { createMutationAttempt } from './mutation-attempt'

describe('mutation attempts', () => {
  test('a reactive version advance retries the exact reply command', async () => {
    const attempt = createMutationAttempt<{ expectedVersion: number; clientOperationId: string }>()
    const calls: { expectedVersion: number; clientOperationId: string }[] = []
    let version = 3
    let loseResponse = true

    const reply = () => attempt.run('support-reply', () => {
      const args = { expectedVersion: version, clientOperationId: `reply-${version}` }
      return async () => {
        calls.push(args)
        if (loseResponse) {
          loseResponse = false
          throw new Error('response lost')
        }
        return args
      }
    })

    await expect(reply()).rejects.toThrow('response lost')
    version = 4
    await expect(reply()).resolves.toEqual({
      expectedVersion: 3,
      clientOperationId: 'reply-3',
    })
    expect(calls).toEqual([
      { expectedVersion: 3, clientOperationId: 'reply-3' },
      { expectedVersion: 3, clientOperationId: 'reply-3' },
    ])
  })

  test('only a server rejection starts a new attempt', async () => {
    const attempt = createMutationAttempt<string>()
    await expect(attempt.run('support-reply', () => async () => {
      throw new ConvexError('definite rejection')
    })).rejects.toBeInstanceOf(ConvexError)
    await expect(attempt.run('support-reply', () => () => Promise.resolve('new'))).resolves.toBe('new')
  })

  test('a fake error payload does not clear an ambiguous attempt', async () => {
    const attempt = createMutationAttempt<string>()
    const firstCommand = async () => {
      throw { data: { code: 'CASE_CHANGED' } }
    }
    await expect(attempt.run('support-reply', () => firstCommand)).rejects.toEqual({
      data: { code: 'CASE_CHANGED' },
    })
    await expect(attempt.run('support-reply', () => () => Promise.resolve('replacement'))).rejects.toEqual({
      data: { code: 'CASE_CHANGED' },
    })
  })

  test('pending-state subscribers can lock an editor until the exact retry completes', async () => {
    const attempt = createMutationAttempt<string>()
    const snapshots: number[] = []
    const unsubscribe = attempt.subscribe(() => snapshots.push(attempt.snapshot()))
    let offline = true
    const send = () => attempt.run('save', () => async () => {
      if (offline) throw new Error('offline')
      return 'saved'
    })

    await expect(send()).rejects.toThrow('offline')
    expect(attempt.hasPending('save')).toBe(true)
    offline = false
    await expect(send()).resolves.toBe('saved')
    expect(attempt.hasPending('save')).toBe(false)
    unsubscribe()
    expect(snapshots).toEqual([1, 2])
  })
})
