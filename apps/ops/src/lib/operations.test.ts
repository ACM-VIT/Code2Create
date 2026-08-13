import assert from 'node:assert/strict'
import test from 'node:test'
import { ConvexError } from 'convex/values'

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

  runner.confirmObservedSuccess('brief')
  assert.equal(runner.hasPending('brief'), false)

  let nextOperationId = ''
  await runner.run('brief', (id) => async () => { nextOperationId = id })
  assert.notEqual(nextOperationId, operationId)
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
