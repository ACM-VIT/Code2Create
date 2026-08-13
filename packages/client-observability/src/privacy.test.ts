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
    contexts: { participant: { email: 'person@example.org', idea: 'private idea' } },
    fingerprint: ['person@example.org', 'private idea'],
    tags: { surface: 'operations-web', participantName: 'Alice' },
    request: {
      url: 'https://event.example.org/admissions/j57abc123?token=secret#answer',
      method: 'post',
      data: { answer: 'private' },
      headers: { authorization: 'Bearer secret' },
      cookies: { session: 'secret' },
    },
    transaction: '/reviews/j57abc123',
    message: 'Failure while reading private idea text',
    logentry: { message: 'failure', params: ['private'] },
    exception: {
      values: [{
        type: 'Error',
        value: 'Participant person@example.org submitted private idea text',
        mechanism: { type: 'generic', data: { target: 'person@example.org' } },
        stacktrace: {
          frames: [{
            function: 'submitApplication',
            module: 'intake',
            package: 'participant-web',
            lineno: 52,
            colno: 8,
            in_app: true,
            filename: 'https://event.example.org/private-project-name.tsx',
            abs_path: '/Users/person@example.org/private-project-name.tsx',
            context_line: 'throw new Error(privateIdea)',
            pre_context: ['const privateIdea = "secret"'],
            post_context: ['send(privateIdea)'],
            vars: { privateIdea: 'secret' },
          }],
        },
      }],
    },
  })

  assert.deepEqual(event.request, {
    url: 'https://event.example.org/admissions/:id',
    method: 'POST',
  })
  assert.equal(event.transaction, '/reviews/:id')
  assert.equal('message' in event, false)
  assert.equal('logentry' in event, false)
  assert.deepEqual(event.exception, {
    values: [{
      type: 'Error',
      stacktrace: {
        frames: [{
          function: 'submitApplication',
          module: 'intake',
          package: 'participant-web',
          lineno: 52,
          colno: 8,
          in_app: true,
        }],
      },
    }],
  })
  assert.equal('user' in event, false)
  assert.equal('extra' in event, false)
  assert.equal('contexts' in event, false)
  assert.equal('fingerprint' in event, false)
  assert.deepEqual(event.tags, { surface: 'operations-web' })
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
      private_context: { email: 'participant@example.org' },
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

test('telemetry default-denies unknown event and breadcrumb fields', () => {
  const event = scrubTelemetryEvent({
    level: 'error',
    tags: { surface: 'alice', email: 'person@example.org' },
    modules: { 'private-project-name': '1.0.0' },
    unknown: { nested: { answer: 'private' } },
    breadcrumbs: [{
      category: 'custom-person@example.org',
      message: 'private idea',
      data: { answer: 'private' },
      unknown: { email: 'person@example.org' },
      level: 'error',
    }],
  })
  assert.deepEqual(event, { level: 'error', breadcrumbs: [{ level: 'error' }] })
})

test('malformed telemetry URLs are replaced', () => {
  assert.equal(sanitizeTelemetryUrl('http://[broken'), '[redacted-url]')
})

test('alphabetic names and opaque identifiers are redacted from paths', () => {
  assert.equal(sanitizeTelemetryUrl('/team/alice'), '/team/:id')
  assert.equal(sanitizeTelemetryUrl('/support/private-project'), '/support/:id')
})
