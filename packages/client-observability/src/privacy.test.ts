import assert from 'node:assert/strict'
import test from 'node:test'

import { sanitizeTelemetryUrl, scrubPostHogEvent } from './privacy.ts'

test('PostHog events remove identity properties, content, and opaque route segments', () => {
  const event = scrubPostHogEvent({
    event: '$exception',
    $set: { email: 'person@example.org' },
    $set_once: { name: 'Alice' },
    properties: {
      token: 'public-project-token',
      distinct_id: 'user-1',
      c2c_surface: 'operations-web',
      participantName: 'Alice',
      proposal: 'private idea',
      $current_url: 'https://event.example.org/admissions/j57abc123?token=secret#answer',
      $pathname: '/reviews/j57abc123',
      $exception_message: 'Failure while reading private idea text',
      $exception_list: [{
        type: 'Error',
        value: 'Participant person@example.org submitted private idea text',
        mechanism: { type: 'generic', handled: true, data: { email: 'person@example.org' } },
        stacktrace: {
          type: 'raw',
          frames: [{
            platform: 'web:javascript',
            function: 'submitApplication',
            module: 'intake',
            package: 'participant-web',
            lineno: 52,
            colno: 8,
            in_app: true,
            filename: 'https://event.example.org/assets/index-a71f.js',
            abs_path: '/Users/person@example.org/private-project-name.tsx',
            context_line: 'throw new Error(privateIdea)',
            pre_context: ['const privateIdea = "secret"'],
            post_context: ['send(privateIdea)'],
            vars: { privateIdea: 'secret' },
            chunk_id: 'chunk-1',
          }],
        },
      }],
    },
  })

  assert.deepEqual(event, {
    event: '$exception',
    properties: {
      token: 'public-project-token',
      distinct_id: 'user-1',
      c2c_surface: 'operations-web',
      $current_url: 'https://event.example.org/admissions/:id',
      $pathname: '/reviews/:id',
      $exception_list: [{
        type: 'Error',
        mechanism: { type: 'generic', handled: true },
        stacktrace: {
          type: 'raw',
          frames: [{
            platform: 'web:javascript',
            function: 'submitApplication',
            module: 'intake',
            package: 'participant-web',
            lineno: 52,
            colno: 8,
            in_app: true,
            filename: 'https://event.example.org/assets/index-a71f.js',
            chunk_id: 'chunk-1',
          }],
        },
      }],
    },
  })
})

test('PostHog privacy filtering default-denies unknown fields', () => {
  const event = scrubPostHogEvent({
    event: 'application_opened',
    properties: {
      token: 'public-project-token',
      unknown: { nested: { answer: 'private' } },
      email: 'person@example.org',
      '$feature/safe-flag': 'enabled',
      $active_feature_flags: ['safe-flag', 42],
    },
  })
  assert.deepEqual(event, {
    event: 'application_opened',
    properties: {
      token: 'public-project-token',
      '$feature/safe-flag': 'enabled',
      $active_feature_flags: ['safe-flag'],
    },
  })
})

test('malformed telemetry URLs are replaced', () => {
  assert.equal(sanitizeTelemetryUrl('http://[broken'), '[redacted-url]')
})

test('alphabetic names and opaque identifiers are redacted from paths', () => {
  assert.equal(sanitizeTelemetryUrl('/team/alice'), '/team/:id')
  assert.equal(sanitizeTelemetryUrl('/support/private-project'), '/support/:id')
})
