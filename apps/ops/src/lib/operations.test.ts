import assert from 'node:assert/strict'
import test from 'node:test'
import { ConvexError } from 'convex/values'

import {
  completeFreshAuthentication,
  currentFreshAuthenticationRequest,
} from './freshAuthentication.ts'
import { createMutationAttempt, createOperationRunner } from './operations.ts'

test('a congested retry keeps the original staff command and id', async () => {
  const runner = createOperationRunner()
  const calls: { expectedVersion: number; clientOperationId: string }[] = []
  let version = 11
  let loseResponse = true

  const save = () => runner.run('support-update', (clientOperationId) => {
    const args = { expectedVersion: version, clientOperationId }
    return async () => {
      calls.push(args)
      if (loseResponse) {
        loseResponse = false
        throw new Error('connection lost')
      }
    }
  })

  await assert.rejects(save, /connection lost/)
  version = 12
  await save()
  assert.deepEqual(calls, [
    { expectedVersion: 11, clientOperationId: calls[0]?.clientOperationId ?? '' },
    { expectedVersion: 11, clientOperationId: calls[0]?.clientOperationId ?? '' },
  ])
})

test('different operation slots do not wedge one another', async () => {
  const runner = createOperationRunner()
  let finish: () => void = () => assert.fail('The command did not start.')
  const first = runner.run('save', () => () => new Promise<void>((resolve) => { finish = resolve }))

  await assert.rejects(() => runner.run('save', () => async () => undefined), /already in progress/)
  await runner.run('publish', () => async () => undefined)
  finish()
  await first
})

test('pending-state subscribers see an uncertain command become locked and then clear', async () => {
  const runner = createOperationRunner()
  const snapshots: number[] = []
  const unsubscribe = runner.subscribe(() => snapshots.push(runner.snapshot()))
  let offline = true
  const send = () => runner.run('save', () => async () => {
    if (offline) throw new Error('offline')
  })

  await assert.rejects(send, /offline/)
  assert.equal(runner.hasPending('save'), true)
  offline = false
  await send()
  assert.equal(runner.hasPending('save'), false)
  unsubscribe()
  assert.deepEqual(snapshots, [1, 2])
})

test('an authoritative observed result can settle an ambiguous command', async () => {
  const runner = createOperationRunner()
  let operationId = ''
  await assert.rejects(() => runner.run('brief', (id) => async () => {
    operationId = id
    throw new Error('response lost')
  }), /response lost/)

  runner.confirmExactObservation('brief')
  assert.equal(runner.hasPending('brief'), false)

  let nextOperationId = ''
  await runner.run('brief', (id) => async () => { nextOperationId = id })
  assert.notEqual(nextOperationId, operationId)
})

test('a pending command can be confirmed without rebuilding its input', async () => {
  const runner = createOperationRunner<number>()
  let responseLost = true
  let calls = 0

  await assert.rejects(
    () => runner.run('decision', () => async () => {
      calls += 1
      if (responseLost) throw new Error('response lost')
      return 9
    }),
    /response lost/,
  )

  responseLost = false
  assert.equal(await runner.retryPending('decision'), 9)
  assert.equal(calls, 2)
  assert.equal(runner.hasPending('decision'), false)
})

test('ConvexError is the only definitive rejection signal', async () => {
  const runner = createOperationRunner()
  let rejectedId = ''
  await assert.rejects(() => runner.run('save', (id) => async () => {
    rejectedId = id
    throw new ConvexError('definite rejection')
  }), ConvexError)
  const correctedIds: string[] = []
  await runner.run('save', (id) => async () => { correctedIds.push(id) })
  assert.notEqual(correctedIds[0], rejectedId)

  let fakeId = ''
  const fakeError = Object.assign(new Error('fake rejection shape'), { data: { code: 'VERSION_CONFLICT' } })
  await assert.rejects(() => runner.run('fake', (id) => async () => {
    fakeId = id
    throw fakeError
  }), fakeError)
  let replacementRan = false
  await assert.rejects(() => runner.run('fake', () => async () => {
    replacementRan = true
  }), fakeError)
  assert.equal(replacementRan, false)
  assert.equal(runner.hasPending('fake'), true)
  assert.notEqual(fakeId, '')
})

test('fresh Google verification retries the exact pending command once', async () => {
  const runner = createOperationRunner<number>()
  const operationIds: string[] = []
  let calls = 0
  const result = runner.run('sensitive-change', (clientOperationId) => async () => {
    operationIds.push(clientOperationId)
    calls += 1
    if (calls === 1) {
      throw new ConvexError({
        code: 'FRESH_AUTH_REQUIRED',
        message: 'Verify with Google again.',
      })
    }
    return 17
  })

  await new Promise<void>((resolve) => setImmediate(resolve))
  const request = currentFreshAuthenticationRequest()
  assert.ok(request)
  assert.equal(runner.hasPending('sensitive-change'), true)
  assert.equal(completeFreshAuthentication(request.id), true)

  assert.equal(await result, 17)
  assert.equal(calls, 2)
  assert.deepEqual(operationIds, [operationIds[0], operationIds[0]])
  assert.equal(runner.hasPending('sensitive-change'), false)
})

test('mutation slots retain immutable closures independently', async () => {
  const attempt = createMutationAttempt<number>()
  let version = 3
  await assert.rejects(() => attempt.run('assignment', () => {
    const captured = version
    return async () => { throw new Error(`lost:${captured}`) }
  }), /lost:3/)
  await assert.rejects(() => attempt.run('publish', () => async () => { throw new Error('lost:publish') }), /lost:publish/)

  version = 4
  await assert.rejects(() => attempt.run('assignment', () => () => Promise.resolve(version)), /lost:3/)
  await assert.rejects(() => attempt.run('assignment', () => () => Promise.resolve(version)), /lost:3/)
  assert.equal(attempt.hasPending('publish'), true)
})

test('a pending mutation can be confirmed without rebuilding its command', async () => {
  const attempt = createMutationAttempt<number>()
  let responseLost = true
  let calls = 0

  await assert.rejects(
    () => attempt.run('pause', () => async () => {
      calls += 1
      if (responseLost) throw new Error('response lost')
      return 7
    }),
    /response lost/,
  )

  responseLost = false
  assert.equal(await attempt.retryPending('pause'), 7)
  assert.equal(calls, 2)
  assert.equal(attempt.hasPending('pause'), false)
})
