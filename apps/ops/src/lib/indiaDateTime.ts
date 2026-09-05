const indiaOffsetMinutes = 5 * 60 + 30;
const localDateTimePattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

export function indiaDateTimeToTimestamp(value: string) {
  const match = localDateTimePattern.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  if (!yearText || !monthText || !dayText || !hourText || !minuteText) return null;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  const local = new Date(localAsUtc);
  if (
    local.getUTCFullYear() !== year ||
    local.getUTCMonth() !== month - 1 ||
    local.getUTCDate() !== day ||
    local.getUTCHours() !== hour ||
    local.getUTCMinutes() !== minute
  )
    return null;
  const timestamp = localAsUtc - indiaOffsetMinutes * 60_000;
  return Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : null;
}

export function optionalIndiaDateTimeToTimestamp(value: string) {
  return value ? indiaDateTimeToTimestamp(value) : undefined;
}

export function timestampToIndiaDateTime(value: number) {
  return new Date(value + indiaOffsetMinutes * 60_000)
    .toISOString()
    .slice(0, 16);
}

export function reviewConfirmationOpening(roundStart: string) {
  const startsAt = indiaDateTimeToTimestamp(roundStart);
  if (startsAt === null) return "";
  const indiaDate = new Date(startsAt + indiaOffsetMinutes * 60_000);
  let opensAt = Date.UTC(
    indiaDate.getUTCFullYear(),
    indiaDate.getUTCMonth(),
    indiaDate.getUTCDate(),
    23,
  );
  if (opensAt >= indiaDate.getTime()) opensAt -= 86_400_000;
  return new Date(opensAt).toISOString().slice(0, 16);
}
