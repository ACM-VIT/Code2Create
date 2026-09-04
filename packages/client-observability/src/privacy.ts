type PostHogEvent = {
  event: string;
  properties?: Record<string, unknown>;
  $set?: unknown;
  $set_once?: unknown;
  $unset?: unknown;
};

const replaySensitiveSelector = "[data-ph-sensitive], .ph-sensitive";
const replaySensitiveFieldPattern =
  /(?:credential|email|full.?name|one.?time|otp|password|phone|registration|room|secret|student.?id|tel|verification.?code)/iu;
const replaySensitiveAttributeNames = new Set([
  "alt",
  "aria-description",
  "aria-label",
  "data-value",
  "title",
  "value",
]);
const telemetrySensitivePropertyPattern =
  /(?:authorization|cookie|credential|email|full.?name|one.?time|otp|password|phone|registration|room.?number|secret|student.?id|verification.?code)/iu;
const telemetryPersonNamePropertyPattern =
  /(?:^name$|(?:display|member|owner|participant|person|recipient|reviewer).?name)/iu;
const telemetrySecretTokenPropertyPattern = /(?:access|auth|id|refresh).?token/iu;
const replayEmailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const replayPhonePattern = /(?<!\d)(?:\+?\d[\d\s().-]{8,}\d)(?!\d)/gu;
const replayRegistrationPattern = /\b\d{2}[A-Z]{2,5}\d{3,6}\b/gu;
const injectedBrowserBridgeFunctions = new Set(["sendDataToNative"]);
const urlProperties = new Set([
  "$current_url",
  "$external_click_url",
  "$initial_current_url",
  "$referrer",
  "$session_entry_url",
]);

export function sanitizeTelemetryUrl(value: string) {
  try {
    const absolute = new URL(value, "https://local.invalid");
    const path = sanitizePathname(absolute.pathname);
    return absolute.origin === "https://local.invalid" ? path : `${absolute.origin}${path}`;
  } catch {
    return redactTelemetryPii(value);
  }
}

export function maskReplayInput(value: string, element?: HTMLElement) {
  return replayElementIsSensitive(element) ? maskedReplayValue(value) : redactTelemetryPii(value);
}

export function maskReplayText(value: string, element?: HTMLElement) {
  return replayElementIsSensitive(element) ? maskedReplayValue(value) : redactTelemetryPii(value);
}

export function maskReplayAttribute(name: string, value: string, element?: Element) {
  if (name === "href" || name === "src" || name === "action") {
    return value.startsWith("data:") || value.startsWith("blob:")
      ? "[redacted-url]"
      : sanitizeTelemetryUrl(value);
  }
  if (
    replaySensitiveFieldPattern.test(name) ||
    (replayElementIsSensitive(element) && replaySensitiveAttributeNames.has(name))
  ) {
    return maskedReplayValue(value);
  }
  return redactTelemetryPii(value);
}

function replayElementIsSensitive(element: Element | undefined) {
  if (element === undefined) {
    return false;
  }
  if (element.closest(replaySensitiveSelector) !== null) {
    return true;
  }
  const metadata = [
    element.id,
    element.getAttribute("name"),
    element.getAttribute("type"),
    element.getAttribute("autocomplete"),
    element.getAttribute("aria-label"),
    // Element also covers SVGElement, so getAttribute is the portable DOM API here.
    // oxlint-disable-next-line unicorn/prefer-dom-node-dataset
    element.getAttribute("data-field"),
  ]
    .filter((value): value is string => value !== null)
    .join(" ");
  return replaySensitiveFieldPattern.test(metadata);
}

function redactTelemetryPii(value: string) {
  return value
    .replace(replayEmailPattern, "[redacted email]")
    .replace(replayPhonePattern, "[redacted phone]")
    .replace(replayRegistrationPattern, "[redacted registration]");
}

function maskedReplayValue(value: string) {
  return value.length === 0 ? "" : "•".repeat(Math.min(Math.max(value.length, 4), 32));
}

export function scrubPostHogEvent<T extends PostHogEvent>(event: T | null): T | null {
  if (event === null) {
    return null;
  }

  // rrweb has already applied the field-level masking functions below. Its
  // payload must remain structurally untouched or the recording is undecodable.
  if (event.event === "$snapshot") {
    return event;
  }
  if (
    event.event === "$exception" &&
    (isInjectedBrowserBridgeException(event.properties) || isAbortException(event.properties))
  ) {
    return null;
  }

  if (event.properties !== undefined) {
    Object.assign(event, { properties: sanitizeTelemetryRecord(event.properties) });
  }
  for (const key of ["$set", "$set_once", "$unset"] as const) {
    const value = event[key];
    if (value !== undefined) {
      Object.assign(event, { [key]: sanitizeTelemetryValue(value, key) });
    }
  }
  return event;
}

function sanitizeTelemetryRecord(record: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, sanitizeTelemetryValue(value, key)]),
  );
}

function sanitizeTelemetryValue(value: unknown, key: string): unknown {
  if (telemetryPropertyIsSensitive(key)) {
    return typeof value === "string" ? maskedReplayValue(value) : "[redacted]";
  }
  if (typeof value === "string") {
    if (urlProperties.has(key)) {
      return sanitizeTelemetryUrl(value);
    }
    if (key === "$pathname") {
      return sanitizePathname(value);
    }
    if (key === "filename" || key === "abs_path") {
      return safeGeneratedFilename(value);
    }
    return redactTelemetryPii(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeTelemetryValue(entry, key));
  }
  if (isRecord(value)) {
    return sanitizeTelemetryRecord(value);
  }
  return value;
}

function telemetryPropertyIsSensitive(key: string) {
  if (key === "token") {
    return false;
  }
  return (
    telemetrySensitivePropertyPattern.test(key) ||
    telemetryPersonNamePropertyPattern.test(key) ||
    telemetrySecretTokenPropertyPattern.test(key)
  );
}

function isAbortException(properties: Record<string, unknown> | undefined) {
  // Libraries abort their own in-flight requests during normal work, so the
  // resulting AbortError is noise rather than a failure. Only this exact name
  // is dropped, so a genuine failure with any other name stays visible.
  const exceptionList = properties?.$exception_list;
  if (!Array.isArray(exceptionList)) {
    return false;
  }
  return exceptionList.some(
    (exception) => isRecord(exception) && exception.type === "AbortError",
  );
}

function isInjectedBrowserBridgeException(properties: Record<string, unknown> | undefined) {
  const exceptionList = properties?.$exception_list;
  if (!Array.isArray(exceptionList)) {
    return false;
  }
  return exceptionList.some((exception) => {
    if (!isRecord(exception) || !isRecord(exception.stacktrace)) {
      return false;
    }
    const frames = exception.stacktrace.frames;
    return (
      Array.isArray(frames) &&
      frames.some(
        (frame) =>
          isRecord(frame) &&
          typeof frame.function === "string" &&
          injectedBrowserBridgeFunctions.has(frame.function),
      )
    );
  });
}

function safeGeneratedFilename(value: string) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return redactTelemetryPii(url.toString());
  } catch {
    return redactTelemetryPii(value.split(/[?#]/u, 1)[0] ?? value);
  }
}

function sanitizePathname(value: string) {
  const pathname = value.startsWith("/") ? value : `/${value}`;
  const segments = pathname.split("/");
  return segments
    .map((segment, index) =>
      index > 0 && segments[index - 1] === "join" ? ":id" : redactTelemetryPii(segment),
    )
    .join("/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
