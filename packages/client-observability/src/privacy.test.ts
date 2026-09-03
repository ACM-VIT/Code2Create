import assert from 'node:assert/strict'
import test from 'node:test'

import {
  maskReplayAttribute,
  maskReplayInput,
  maskReplayText,
  sanitizeTelemetryUrl,
  scrubPostHogEvent,
} from './privacy.ts'

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
        value: 'Participant [redacted email] submitted private idea text',
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

test('exceptions from injected third-party scripts are dropped', () => {
  const bridgeError = scrubPostHogEvent({
    event: '$exception',
    properties: {
      token: 'public-project-token',
      $exception_list: [{
        type: 'Error',
        value: 'undefined is not an object',
        mechanism: { type: 'onerror', handled: false },
        stacktrace: {
          type: 'raw',
          frames: [{
            function: 'sendDataToNative',
            in_app: true,
            filename: 'https://c2c.sh/',
          }],
        },
      }],
    },
  })
  assert.equal(bridgeError, null)

  const extensionError = scrubPostHogEvent({
    event: '$exception',
    properties: {
      token: 'public-project-token',
      $exception_list: [{
        type: 'TypeError',
        value: 'boom',
        stacktrace: {
          type: 'raw',
          frames: [{ function: 'inject', filename: 'chrome-extension://abcdef/content.js' }],
        },
      }],
    },
  })
  assert.equal(extensionError, null)
})

test('native bundle exceptions from React Native are kept and keep the bundle filename', () => {
  const appScheme = scrubPostHogEvent({
    event: '$exception',
    properties: {
      token: 'public-project-token',
      $exception_list: [{
        type: 'Error',
        value: 'Reviewer render failed',
        stacktrace: {
          type: 'raw',
          frames: [{ function: 'submitReview', filename: 'app:///index.bundle', in_app: true }],
        },
      }],
    },
  })
  assert.deepEqual(appScheme, {
    event: '$exception',
    properties: {
      token: 'public-project-token',
      $exception_list: [{
        type: 'Error',
        value: 'Reviewer render failed',
        stacktrace: {
          type: 'raw',
          frames: [{ function: 'submitReview', filename: 'app:///index.bundle', in_app: true }],
        },
      }],
    },
  })

  const androidBundle = scrubPostHogEvent({
    event: '$exception',
    properties: {
      token: 'public-project-token',
      $exception_list: [{
        type: 'TypeError',
        value: 'undefined is not a function',
        stacktrace: {
          type: 'raw',
          frames: [{ function: 'render', filename: 'index.android.bundle' }],
        },
      }],
    },
  })
  assert.notEqual(androidBundle, null)
})

test('third-party frame paths are redacted while the origin is kept', () => {
  const event = scrubPostHogEvent({
    event: '$exception',
    properties: {
      token: 'public-project-token',
      $exception_list: [{
        type: 'Error',
        value: 'Rendering failed',
        stacktrace: {
          type: 'raw',
          frames: [
            { function: 'render', filename: 'https://c2c.sh/assets/index-a71f.js' },
            { function: 'load', filename: 'https://third.example/tenant-secret/project-123/script.js' },
          ],
        },
      }],
    },
  })
  assert.deepEqual(event, {
    event: '$exception',
    properties: {
      token: 'public-project-token',
      $exception_list: [{
        type: 'Error',
        value: 'Rendering failed',
        stacktrace: {
          type: 'raw',
          frames: [
            { function: 'render', filename: 'https://c2c.sh/assets/index-a71f.js' },
            { function: 'load', filename: 'https://third.example/:id/:id/:id' },
          ],
        },
      }],
    },
  })
})

test('a real exception with a third-party cause is kept and keeps recognizable filenames', () => {
  const event = scrubPostHogEvent({
    event: '$exception',
    properties: {
      token: 'public-project-token',
      $exception_list: [{
        type: 'Error',
        value: 'Rendering failed',
        stacktrace: {
          type: 'raw',
          frames: [
            { function: 'render', filename: 'https://c2c.sh/assets/index-a71f.js' },
            { function: 'sendDataToNative', filename: 'https://c2c.sh/' },
          ],
        },
      }],
    },
  })
  assert.deepEqual(event, {
    event: '$exception',
    properties: {
      token: 'public-project-token',
      $exception_list: [{
        type: 'Error',
        value: 'Rendering failed',
        stacktrace: {
          type: 'raw',
          frames: [
            { function: 'render', filename: 'https://c2c.sh/assets/index-a71f.js' },
            { function: 'sendDataToNative', filename: 'https://c2c.sh/' },
          ],
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
      c2c_action: 'application_opened',
      $elements: [{
        tag_name: 'button',
        nth_child: 2,
        classes: ['primary-button', 'unsafe class'],
        text: 'private idea',
        'attr__data-email': 'person@example.org',
      }],
    },
  })
  assert.deepEqual(event, {
    event: 'application_opened',
    properties: {
      token: 'public-project-token',
      '$feature/safe-flag': 'enabled',
      $active_feature_flags: ['safe-flag'],
      c2c_action: 'application_opened',
      $elements: [{
        tag_name: 'button',
        nth_child: 2,
        classes: ['primary-button'],
      }],
    },
  })
})

test('session replay payloads remain decodable after recorder masking', () => {
  const event = {
    event: '$snapshot',
    properties: {
      $snapshot_data: { type: 3, data: { source: 0 } },
      $session_id: 'session-1',
    },
  }
  assert.equal(scrubPostHogEvent(event), event)
})

test('session replay keeps project text while redacting PII and sensitive attributes', () => {
  const idea = 'A debugging workspace that replays production failures.'
  assert.equal(maskReplayInput(idea), idea)
  assert.equal(maskReplayText(idea), idea)
  assert.equal(
    maskReplayText('Contact person@example.org or +91 98765 43210, 23BCE1234.'),
    'Contact [redacted email] or [redacted phone], [redacted registration].',
  )
  assert.match(maskReplayAttribute('data-email', 'person@example.org'), /^•+$/u)
})

test('malformed telemetry URLs are replaced', () => {
  assert.equal(sanitizeTelemetryUrl('http://[broken'), '[redacted-url]')
})

test('alphabetic names and opaque identifiers are redacted from paths', () => {
  assert.equal(sanitizeTelemetryUrl('/team/alice'), '/team/:id')
  assert.equal(sanitizeTelemetryUrl('/support/private-project'), '/support/:id')
})
