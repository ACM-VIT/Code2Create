type PostHogEvent = {
  event: string
  properties?: Record<string, unknown>
}

type SafeException = {
  type?: string
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

export function scrubPostHogEvent<T extends PostHogEvent>(event: T | null): T | null {
  if (!event) return null

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
    if (safeScalarProperties.has(key) || key.startsWith('$feature/')) {
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
    }
  }
  return safe
}

function safeExceptionList(value: unknown): SafeException[] | null {
  if (!Array.isArray(value)) return null
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return []
    const exception: SafeException = {}
    if (typeof entry.type === 'string') exception.type = entry.type
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
  try {
    const url = new URL(value, 'https://local.invalid')
    if (!url.pathname.startsWith('/assets/')) return null
    if (!/^\/[A-Za-z0-9._~/-]+$/u.test(url.pathname)) return null
    return url.origin === 'https://local.invalid' ? url.pathname : `${url.origin}${url.pathname}`
  } catch {
    return null
  }
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
