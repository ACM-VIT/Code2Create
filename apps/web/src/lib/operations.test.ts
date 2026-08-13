import assert from 'node:assert/strict'
import test from 'node:test'
import { ConvexError } from 'convex/values'

import { createMutationAttempt, createOperationRunner } from './operations.ts'

test('an ambiguous failure retries the exact command and operation id', async () => {
  const runner = createOperationRunner()
  const calls: { version: number; id: string }[] = []
  let version = 7
  let loseResponse = true

  const send = () => runner.run('submit', (id) => {
    const args = { version, id }
    return async () => {
      calls.push(args)
      if (loseResponse) {
        loseResponse = false
        throw new Error('offline')
      }
    }
  })

  await assert.rejects(send, /offline/)
  version = 8
  await send()
  assert.deepEqual(calls, [
    { version: 7, id: calls[0]?.id ?? '' },
    { version: 7, id: calls[0]?.id ?? '' },
  ])
})

test('slots run independently while a duplicate submit is blocked', async () => {
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

test('only a real ConvexError proves a command was rejected', async () => {
  const runner = createOperationRunner()
  let convexId = ''
  await assert.rejects(() => runner.run('convex', (id) => async () => {
    convexId = id
    throw new ConvexError('definite rejection')
  }), ConvexError)
  const nextConvexId: string[] = []
  await runner.run('convex', (id) => async () => { nextConvexId.push(id) })
  assert.notEqual(nextConvexId[0], convexId)

  let ambiguousId = ''
  const fakeError = Object.assign(new Error('fake rejection shape'), { data: { code: 'FAKE' } })
  await assert.rejects(() => runner.run('fake', (id) => async () => {
    ambiguousId = id
    throw fakeError
  }), fakeError)
  let replacementRan = false
  await assert.rejects(() => runner.run('fake', () => async () => {
    replacementRan = true
  }), fakeError)
  assert.equal(replacementRan, false)
  assert.equal(runner.hasPending('fake'), true)
  assert.notEqual(ambiguousId, '')
})

test('an edit cannot replace an ambiguous mutation slot', async () => {
  const attempt = createMutationAttempt<string>()
  let value = 'first'
  await assert.rejects(() => attempt.run('reply', () => {
    const captured = value
    return async () => { throw new Error(captured) }
  }), /first/)
  await assert.rejects(() => attempt.run('owner', () => async () => { throw new Error('owner') }), /owner/)

  value = 'edited'
  await assert.rejects(() => attempt.run('reply', () => {
    const captured = value
    return () => Promise.resolve(captured)
  }), /first/)
  assert.equal(attempt.hasPending('owner'), true)
})
