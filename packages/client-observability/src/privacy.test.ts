import assert from 'node:assert/strict'
import test from 'node:test'

import {
  sanitizeTelemetryUrl,
  scrubTelemetryBreadcrumb,
  scrubTelemetryEvent,
} from './privacy.ts'

test('telemetry removes identity, request payloads, secrets, and opaque route segments', () => {
  const event = scrubTelemetryEvent({
    user: { id: 'person-1', email: 'person@example.org' },
    extra: { projectText: 'private idea' },
    request: {
      url: 'https://event.example.org/admissions/j57abc123?token=secret#answer',
      method: 'post',
      data: { answer: 'private' },
      headers: { authorization: 'Bearer secret' },
      cookies: { session: 'secret' },
    },
    transaction: '/reviews/j57abc123',
    logentry: { message: 'failure', params: ['private'] },
  })

  assert.deepEqual(event.request, {
    url: 'https://event.example.org/admissions/:id',
    method: 'POST',
  })
  assert.equal(event.transaction, '/reviews/:id')
  assert.deepEqual(event.logentry, { message: 'failure' })
  assert.equal('user' in event, false)
  assert.equal('extra' in event, false)
})

test('telemetry drops console breadcrumbs and keeps only safe transport facts', () => {
  assert.equal(
    scrubTelemetryBreadcrumb({ category: 'console', message: 'participant@example.org' }),
    null,
  )
  assert.deepEqual(
    scrubTelemetryBreadcrumb({
      category: 'fetch',
      message: 'private response',
      data: {
        url: 'https://api.example.org/team/k17secret?code=oauth',
        method: 'post',
        status_code: 503,
        request_body: 'private',
      },
    }),
    {
      category: 'fetch',
      data: {
        url: 'https://api.example.org/team/:id',
        method: 'POST',
        status_code: 503,
      },
    },
  )
})

test('malformed telemetry URLs are replaced', () => {
  assert.equal(sanitizeTelemetryUrl('http://[broken'), '[redacted-url]')
})
