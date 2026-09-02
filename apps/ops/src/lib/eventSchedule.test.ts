import assert from 'node:assert/strict'
import { test } from 'node:test'

import { eventScheduleError } from './eventSchedule.ts'

const hour = 60 * 60 * 1_000
const startsAt = Date.UTC(2026, 8, 7, 8, 30)
const valid = {
  startsAt,
  endsAt: startsAt + 48 * hour,
  externalApplicationsCloseAt: startsAt - 48 * hour,
  applicationsCloseAt: startsAt - 24 * hour,
}

test('accepts external before VIT before start before end', () => {
  assert.equal(eventScheduleError(valid), null)
})

test('accepts equal external and VIT deadlines', () => {
  assert.equal(
    eventScheduleError({ ...valid, externalApplicationsCloseAt: valid.applicationsCloseAt }),
    null,
  )
})

test('names a missing or unparsable date', () => {
  assert.match(
    eventScheduleError({ ...valid, externalApplicationsCloseAt: null }) ?? '',
    /valid date and time/,
  )
})

test('rejects an event that ends before it starts', () => {
  assert.equal(
    eventScheduleError({ ...valid, endsAt: startsAt }),
    'The event must end after it starts.',
  )
})

test('rejects external applications closing after VIT applications', () => {
  assert.equal(
    eventScheduleError({
      ...valid,
      externalApplicationsCloseAt: valid.applicationsCloseAt + hour,
    }),
    'External applications must close no later than VIT applications.',
  )
})

test('rejects VIT applications closing after the event starts', () => {
  assert.equal(
    eventScheduleError({
      ...valid,
      externalApplicationsCloseAt: startsAt + hour,
      applicationsCloseAt: startsAt + hour,
    }),
    'VIT applications must close no later than the event start.',
  )
})
