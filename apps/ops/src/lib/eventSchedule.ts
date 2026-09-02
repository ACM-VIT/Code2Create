export type EventScheduleInput = {
  startsAt: number | null
  endsAt: number | null
  externalApplicationsCloseAt: number | null
  applicationsCloseAt: number | null
}

export function eventScheduleError(schedule: EventScheduleInput) {
  const { startsAt, endsAt, externalApplicationsCloseAt, applicationsCloseAt } = schedule
  if (
    startsAt === null
    || endsAt === null
    || externalApplicationsCloseAt === null
    || applicationsCloseAt === null
  ) {
    return 'Enter a valid date and time for both application deadlines, the event start, and the event end.'
  }
  if (endsAt <= startsAt) {
    return 'The event must end after it starts.'
  }
  if (externalApplicationsCloseAt > applicationsCloseAt) {
    return 'External applications must close no later than VIT applications.'
  }
  if (applicationsCloseAt > startsAt) {
    return 'VIT applications must close no later than the event start.'
  }
  return null
}
