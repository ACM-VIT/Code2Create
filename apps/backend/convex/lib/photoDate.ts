import { parse } from "exifr";

// EXIF without an offset is camera-local time; this event's cameras are in India.
export function parsePhotoDate(
  value: unknown,
  offset: unknown,
): number | undefined {
  if (typeof value !== "string") return;
  const match = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(
    value,
  );
  if (!match) return;
  const [, year, month, day, hour, minute, second] = match;
  const local = `${year}-${month}-${day}T${hour}:${minute}:${second}`;
  const wallTime = Date.parse(`${local}Z`);
  if (
    !Number.isFinite(wallTime) ||
    new Date(wallTime).toISOString().slice(0, 19) !== local
  )
    return;
  const zone =
    typeof offset === "string" && /^[+-](0\d|1[0-4]):[0-5]\d$/.test(offset)
      ? offset
      : "+05:30";
  const timestamp = Date.parse(`${local}${zone}`);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

export async function photoCaptureDate(
  bytes: Uint8Array,
): Promise<number | undefined> {
  try {
    const metadata: unknown = await parse(bytes, {
      pick: ["DateTimeOriginal", "OffsetTimeOriginal"],
      reviveValues: false,
    });
    if (!metadata || typeof metadata !== "object") return;
    return parsePhotoDate(
      "DateTimeOriginal" in metadata ? metadata.DateTimeOriginal : undefined,
      "OffsetTimeOriginal" in metadata
        ? metadata.OffsetTimeOriginal
        : undefined,
    );
  } catch {
    return undefined;
  }
}

export function photoDay(
  capturedAt: number | undefined,
  eventMonth: string | undefined,
): "6" | "7" | "8" | "other" {
  if (capturedAt === undefined || !eventMonth || !Number.isFinite(capturedAt))
    return "other";
  const local = new Date(capturedAt + 330 * 60_000).toISOString().slice(0, 10);
  if (local === `${eventMonth}-06`) return "6";
  if (local === `${eventMonth}-07`) return "7";
  if (local === `${eventMonth}-08`) return "8";
  return "other";
}
