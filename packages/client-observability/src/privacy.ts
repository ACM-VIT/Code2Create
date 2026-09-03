type PostHogEvent = {
  event: string
  properties?: Record<string, unknown>
}

type SafeException = {
  type?: string
  value?: string
  mechanism?: {
    handled?: boolean
    synthetic?: boolean
    type?: string
  }
  stacktrace?: {
    type: 'raw'
    frames: SafeStackFrame[]
  }
}

type SafeStackFrame = {
  platform?: string
  filename?: string
  function?: string
  module?: string
  package?: string
  lineno?: number
  colno?: number
  in_app?: boolean
  instruction_addr?: string
  addr_mode?: string
  chunk_id?: string
}

const opaqueSegment = ':id'
const replaySensitiveSelector = '[data-ph-sensitive], .ph-sensitive'
const replaySensitiveContextSelector = [
  '[class*="account" i]',
  '[class*="approval" i]',
  '[class*="candidate" i]',
  '[class*="identity" i]',
  '[class*="intelligence" i]',
  '[class*="invitation" i]',
  '[class*="member" i]',
  '[class*="owner" i]',
  '[class*="participant" i]',
  '[class*="person" i]',
  '[class*="profile" i]',
  '[class*="recipient" i]',
  '[class*="reviewer" i]',
  '[class*="roster" i]',
  '[class*="support" i]',
].join(', ')
const replaySensitiveFieldPattern = /(?:account|college|credential|email|full.?name|gender|hostel|identity|invitee|member|name|one.?time|otp|owner|participant|password|person|phone|recipient|registration|reviewer|room|secret|student.?id|tel|token|university|verification.?code)/iu
const replayEmailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu
const replayPhonePattern = /(?<!\d)(?:\+?\d[\d\s().-]{8,}\d)(?!\d)/gu
const replayRegistrationPattern = /\b\d{2}[A-Z]{2,5}\d{3,6}\b/gu
const safeScalarProperties = new Set([
  'token',
  'distinct_id',
  '$app_build',
  '$app_name',
  '$app_namespace',
  '$app_version',
  '$browser',
  '$browser_version',
  '$device_id',
  '$device_manufacturer',
  '$device_model',
  '$device_type',
  '$exception_level',
  '$geoip_disable',
  '$insert_id',
  '$is_emulator',
  '$is_identified',
  '$lib',
  '$lib_version',
  '$locale',
  '$os',
  '$os_name',
  '$os_version',
  '$process_person_profile',
  '$release_id',
  '$screen_height',
  '$screen_width',
  '$session_id',
  '$time',
  '$timezone',
  '$title',
  '$viewport_height',
  '$viewport_width',
  '$window_id',
  'c2c_environment',
  'c2c_release',
  'c2c_surface',
])
const safeUrlProperties = new Set([
  '$current_url',
  '$external_click_url',
  '$initial_current_url',
  '$referrer',
  '$session_entry_url',
])
const staticRouteSegments = new Set([
  'access',
  'admissions',
  'attendance',
  'callback',
  'checkpoints',
  'configuration',
  'emergency-pack',
  'figma',
  'floor',
  'github',
  'health',
  'integrations',
  'intelligence',
  'join',
  'profile',
  'rehearsal',
  'reviews',
  'scores',
  'submitted',
  'support',
  'synesthesia',
  'team',
])

export function sanitizeTelemetryUrl(value: string) {
  try {
    const absolute = new URL(value, 'https://local.invalid')
    const path = sanitizePathname(absolute.pathname)
    return absolute.origin === 'https://local.invalid' ? path : `${absolute.origin}${path}`
  } catch {
    return '[redacted-url]'
  }
}

export function maskReplayInput(value: string, element?: HTMLElement) {
  return replayElementIsSensitive(element) ? maskedReplayValue(value) : redactReplayPii(value)
}

export function maskReplayText(value: string, element?: HTMLElement) {
  return replayElementIsSensitive(element) ? maskedReplayValue(value) : redactReplayPii(value)
}

export function maskReplayAttribute(name: string, value: string, element?: Element) {
  if (replayElementIsSensitive(element) || replaySensitiveFieldPattern.test(name)) {
    return maskedReplayValue(value)
  }
  if (name === 'href' || name === 'src' || name === 'action') {
    return value.startsWith('data:') || value.startsWith('blob:')
      ? '[redacted-url]'
      : sanitizeTelemetryUrl(value)
  }
  return redactReplayPii(value)
}

function replayElementIsSensitive(element: Element | undefined) {
  if (!element) return false
  if (element.closest(replaySensitiveSelector)) return true
  if (element.closest(replaySensitiveContextSelector)) return true
  const metadata = [
    element.id,
    element.getAttribute('name'),
    element.getAttribute('type'),
    element.getAttribute('autocomplete'),
    element.getAttribute('aria-label'),
    element.getAttribute('data-field'),
  ].filter((value): value is string => value !== null).join(' ')
  return replaySensitiveFieldPattern.test(metadata)
}

function redactReplayPii(value: string) {
  return value
    .replace(replayEmailPattern, '[redacted email]')
    .replace(replayPhonePattern, '[redacted phone]')
    .replace(replayRegistrationPattern, '[redacted registration]')
}

function maskedReplayValue(value: string) {
  return value.length === 0 ? '' : '•'.repeat(Math.min(Math.max(value.length, 4), 32))
}

export function scrubPostHogEvent<T extends PostHogEvent>(event: T | null): T | null {
  if (!event) return null

  // Replay payloads are produced after rrweb has applied the provider's input,
  // text, attribute, body, and header masking. Re-shaping the payload here makes
  // recordings undecodable, so the replay event is passed through intact.
  if (event.event === '$snapshot') return event

  const exceptionList = event.properties ? safeExceptionList(event.properties.$exception_list) : null
  if (exceptionList && exceptionListIsInjectedThirdParty(exceptionList)) return null

  const properties = event.properties ? safeEventProperties(event.properties) : undefined
  Reflect.deleteProperty(event, '$set')
  Reflect.deleteProperty(event, '$set_once')
  Reflect.deleteProperty(event, '$unset')
  if (properties) Object.assign(event, { properties })
  return event
}

function safeEventProperties(properties: Record<string, unknown>) {
  const safe: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(properties)) {
    if (
      safeScalarProperties.has(key)
      || key.startsWith('$feature/')
      || key.startsWith('$web_vitals_')
      || key.startsWith('$performance_')
      || key.startsWith('$dead_click_')
      || key.startsWith('$rageclick_')
      || key.startsWith('c2c_')
    ) {
      if (isScalar(value)) safe[key] = value
      continue
    }
    if (safeUrlProperties.has(key) && typeof value === 'string') {
      safe[key] = sanitizeTelemetryUrl(value)
      continue
    }
    if (key === '$pathname' && typeof value === 'string') {
      safe[key] = sanitizePathname(value)
      continue
    }
    if ((key === '$host' || key === '$referring_domain') && typeof value === 'string') {
      safe[key] = safeHostname(value)
      continue
    }
    if (key === '$active_feature_flags' && Array.isArray(value)) {
      safe[key] = value.filter((entry): entry is string => typeof entry === 'string')
      continue
    }
    if (key === '$exception_list') {
      const exceptionList = safeExceptionList(value)
      if (exceptionList) safe[key] = exceptionList
      continue
    }
    if (key === '$elements' && Array.isArray(value)) {
      safe[key] = value.flatMap((entry) => isRecord(entry) ? [safeAutocaptureElement(entry)] : [])
    }
  }
  return safe
}

function safeAutocaptureElement(element: Record<string, unknown>) {
  const safe: Record<string, unknown> = {}
  for (const key of ['tag_name', 'nth_child', 'nth_of_type'] as const) {
    const value = element[key]
    if (isScalar(value)) safe[key] = value
  }
  const classes = element.classes
  if (Array.isArray(classes)) {
    safe.classes = classes.filter((entry): entry is string =>
      typeof entry === 'string' && /^[A-Za-z0-9_-]{1,80}$/u.test(entry))
  }
  return safe
}

function safeExceptionList(value: unknown): SafeException[] | null {
  if (!Array.isArray(value)) return null
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return []
    const exception: SafeException = {}
    if (typeof entry.type === 'string') exception.type = entry.type
    // Keep the message so error tracking can name the issue, but scrub the
    // emails, phone numbers, and registration numbers a message can carry.
    if (typeof entry.value === 'string') exception.value = redactReplayPii(entry.value)
    if (isRecord(entry.mechanism)) {
      const mechanism: SafeException['mechanism'] = {}
      if (typeof entry.mechanism.handled === 'boolean') mechanism.handled = entry.mechanism.handled
      if (typeof entry.mechanism.synthetic === 'boolean') mechanism.synthetic = entry.mechanism.synthetic
      if (typeof entry.mechanism.type === 'string') mechanism.type = entry.mechanism.type
      if (Object.keys(mechanism).length > 0) exception.mechanism = mechanism
    }
    if (isRecord(entry.stacktrace) && Array.isArray(entry.stacktrace.frames)) {
      exception.stacktrace = {
        type: 'raw',
        frames: entry.stacktrace.frames.flatMap((frame) => isRecord(frame) ? [safeStackFrame(frame)] : []),
      }
    }
    return [exception]
  })
}

function safeStackFrame(frame: Record<string, unknown>): SafeStackFrame {
  const safe: SafeStackFrame = {}
  if (typeof frame.platform === 'string') safe.platform = frame.platform
  if (typeof frame.filename === 'string') {
    const filename = safeGeneratedFilename(frame.filename)
    if (filename) safe.filename = filename
  }
  if (typeof frame.function === 'string') safe.function = frame.function
  if (typeof frame.module === 'string') safe.module = frame.module
  if (typeof frame.package === 'string') safe.package = frame.package
  if (typeof frame.lineno === 'number' && Number.isFinite(frame.lineno)) safe.lineno = frame.lineno
  if (typeof frame.colno === 'number' && Number.isFinite(frame.colno)) safe.colno = frame.colno
  if (typeof frame.in_app === 'boolean') safe.in_app = frame.in_app
  if (typeof frame.instruction_addr === 'string') safe.instruction_addr = frame.instruction_addr
  if (typeof frame.addr_mode === 'string') safe.addr_mode = frame.addr_mode
  if (typeof frame.chunk_id === 'string') safe.chunk_id = frame.chunk_id
  return safe
}

function safeGeneratedFilename(value: string) {
  let url: URL
  try {
    url = new URL(value, 'https://local.invalid')
  } catch {
    return null
  }
  if (url.protocol === 'app:') {
    // React Native and Expo report application frames under the app:// scheme
    // with a JavaScript bundle path. Keep the path so native faults stay named.
    return isApplicationBundlePath(url.pathname) ? `app://${url.pathname}` : null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    // Browser extensions and native in-app browser bridges inject scripts under
    // other non-web schemes. Keep the scheme so the frame stays recognizable
    // while dropping the extension id and path, which can carry identifiers.
    return `${url.protocol}//[redacted]`
  }
  // Our generated asset and bundle filenames are hashed and safe to keep whole.
  // A third-party path can carry tenant or project identifiers, so redact its
  // segments while keeping the origin that names the third party.
  const pathname = isApplicationBundlePath(url.pathname) && /^\/[A-Za-z0-9._~/-]*$/u.test(url.pathname)
    ? url.pathname
    : sanitizePathname(url.pathname)
  return url.origin === 'https://local.invalid' ? pathname : `${url.origin}${pathname}`
}

function exceptionListIsInjectedThirdParty(list: SafeException[]): boolean {
  // Scripts injected by browser extensions and native in-app browser bridges run
  // in the page but are not part of our bundle, so their frames never resolve to
  // our own asset or native bundle code. Drop the exception the way
  // browserRecovery.ts drops chunk load failures: these faults are not ours to
  // fix and arrive unnamed. A chain that touches our code anywhere is kept, so a
  // real error with a third-party cause still reports.
  const filenames = list
    .flatMap((exception) => exception.stacktrace?.frames ?? [])
    .flatMap((frame) => typeof frame.filename === 'string' ? [frame.filename] : [])
  return filenames.length > 0 && filenames.every((filename) => !filenameIsApplicationCode(filename))
}

function filenameIsApplicationCode(filename: string): boolean {
  try {
    const url = new URL(filename, 'https://local.invalid')
    return (url.protocol === 'app:' || url.protocol === 'https:' || url.protocol === 'http:')
      && isApplicationBundlePath(url.pathname)
  } catch {
    return false
  }
}

function isApplicationBundlePath(pathname: string): boolean {
  return pathname.startsWith('/assets/') || /\.(?:js)?bundle$/u.test(pathname)
}

function sanitizePathname(value: string) {
  const pathname = value.startsWith('/') ? value : `/${value}`
  return pathname
    .split('/')
    .map((segment) => !segment || staticRouteSegments.has(segment) ? segment : opaqueSegment)
    .join('/')
}

function safeHostname(value: string) {
  return /^[a-z0-9.-]+$/iu.test(value) ? value.toLowerCase() : '[redacted-host]'
}

function isScalar(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
