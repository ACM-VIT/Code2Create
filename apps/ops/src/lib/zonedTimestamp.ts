import { TZDateMini } from "@date-fns/tz";

export function zonedTimestamp(value: string, timezone: string, label: string) {
  const [datePart, timePart] = value.split("T");
  const datePieces = datePart?.split("-");
  const timePieces = timePart?.split(":");
  const year = Number(datePieces?.[0]);
  const month = Number(datePieces?.[1]);
  const day = Number(datePieces?.[2]);
  const hour = Number(timePieces?.[0]);
  const minute = Number(timePieces?.[1]);
  if ([year, month, day, hour, minute].some((part) => !Number.isInteger(part))) {
    throw new Error(`${label} is incomplete.`);
  }
  const date = new TZDateMini(year, month - 1, day, hour, minute, timezone);
  if (
    !Number.isFinite(date.getTime()) ||
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute
  ) {
    throw new Error(`${label} is not a valid local time in ${timezone}.`);
  }
  return date.getTime();
}


export function zonedInputValue(timestamp: number | undefined, timezone: string) {
  if (timestamp === undefined) return "";
  const date = new TZDateMini(timestamp, timezone);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
