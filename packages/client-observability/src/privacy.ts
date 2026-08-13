type TelemetryRequest = {
  url?: string
  method?: string
  data?: unknown
  query_string?: unknown
  cookies?: Record<string, string>
  env?: Record<string, string>
  headers?: Record<string, string>
}

type TelemetryBreadcrumb = {
  type?: string
  level?: string
  event_id?: string
  category?: string
  message?: string
  data?: Record<string, unknown>
  timestamp?: number
}

type TelemetryStackFrame = {
  function?: string
  module?: string
  package?: string
  lineno?: number
  colno?: number
  in_app?: boolean
}

type TelemetryEvent = {
  event_id?: string
  timestamp?: number
  platform?: string
  level?: string
  release?: string
  environment?: string
  dist?: string
  tags?: Record<string, unknown>
  user?: object
  extra?: object
  request?: TelemetryRequest
  breadcrumbs?: TelemetryBreadcrumb[]
  transaction?: string
  message?: string
  exception?: {
    values?: Array<{
      type?: string
      value?: string
      stacktrace?: { frames?: TelemetryStackFrame[] }
      mechanism?: object
    }>
  }
  logentry?: {
    message?: string
    params?: unknown[]
  }
}

const opaqueSegment = ':id'
const telemetrySurfaces = new Set(['participant-web', 'operations-web', 'reviewer', 'trailer', 'handbook'])
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
    const path = absolute.pathname
      .split('/')
      .map((segment) => safePathSegment(segment))
      .join('/')
    return absolute.origin === 'https://local.invalid' ? path : `${absolute.origin}${path}`
  } catch {
    return '[redacted-url]'
  }
}

export function scrubTelemetryEvent<T extends TelemetryEvent>(event: T) {
  const safe: TelemetryEvent = {}
  if (event.event_id) safe.event_id = event.event_id
  if (typeof event.timestamp === 'number' && Number.isFinite(event.timestamp)) safe.timestamp = event.timestamp
  if (event.platform) safe.platform = event.platform
  if (event.level) safe.level = event.level
  if (event.release) safe.release = event.release
  if (event.environment) safe.environment = event.environment
  if (event.dist) safe.dist = event.dist
  const surface = event.tags?.surface
  if (typeof surface === 'string' && telemetrySurfaces.has(surface)) safe.tags = { surface }
  if (event.request) {
    const request: TelemetryRequest = {}
    if (event.request.method) request.method = event.request.method.toUpperCase()
    if (event.request.url) request.url = sanitizeTelemetryUrl(event.request.url)
    if (Object.keys(request).length > 0) safe.request = request
  }
  if (event.breadcrumbs) {
    safe.breadcrumbs = event.breadcrumbs.flatMap((breadcrumb) => {
      const safe = scrubTelemetryBreadcrumb(breadcrumb)
      return safe ? [safe] : []
    })
  }
  if (event.transaction?.startsWith('/')) {
    safe.transaction = sanitizeTelemetryUrl(event.transaction)
  }
  if (event.exception?.values) {
    safe.exception = { values: event.exception.values.map((value) => ({
      ...(value.type ? { type: value.type } : {}),
      ...(value.stacktrace?.frames
        ? { stacktrace: { frames: value.stacktrace.frames.map(safeStackFrame) } }
        : {}),
    })) }
  }
  for (const key of Object.keys(event)) Reflect.deleteProperty(event, key)
  Object.assign(event, safe)
  return event
}

function safeStackFrame(frame: TelemetryStackFrame): TelemetryStackFrame {
  return {
    ...(frame.function ? { function: frame.function } : {}),
    ...(frame.module ? { module: frame.module } : {}),
    ...(frame.package ? { package: frame.package } : {}),
    ...(typeof frame.lineno === 'number' ? { lineno: frame.lineno } : {}),
    ...(typeof frame.colno === 'number' ? { colno: frame.colno } : {}),
    ...(typeof frame.in_app === 'boolean' ? { in_app: frame.in_app } : {}),
  }
}

export function scrubTelemetryBreadcrumb<T extends TelemetryBreadcrumb>(breadcrumb: T) {
  if (breadcrumb.category === 'console') return null

  const safe: TelemetryBreadcrumb = {}
  if (breadcrumb.type) safe.type = breadcrumb.type
  if (breadcrumb.level) safe.level = breadcrumb.level
  if (breadcrumb.event_id) safe.event_id = breadcrumb.event_id
  if (typeof breadcrumb.timestamp === 'number' && Number.isFinite(breadcrumb.timestamp)) {
    safe.timestamp = breadcrumb.timestamp
  }

  if (breadcrumb.data) {
    if (breadcrumb.category === 'fetch' || breadcrumb.category === 'xhr') {
      safe.category = breadcrumb.category
      const data: Record<string, unknown> = {}
      const url = breadcrumb.data.url
      const method = breadcrumb.data.method
      const status = breadcrumb.data.status_code
      if (typeof url === 'string') data.url = sanitizeTelemetryUrl(url)
      if (typeof method === 'string') data.method = method.toUpperCase()
      if (typeof status === 'number' && Number.isFinite(status)) data.status_code = status
      if (Object.keys(data).length > 0) safe.data = data
    } else if (breadcrumb.category === 'navigation') {
      safe.category = breadcrumb.category
      const data: Record<string, unknown> = {}
      const from = breadcrumb.data.from
      const to = breadcrumb.data.to
      if (typeof from === 'string') data.from = sanitizeTelemetryUrl(from)
      if (typeof to === 'string') data.to = sanitizeTelemetryUrl(to)
      if (Object.keys(data).length > 0) safe.data = data
    }
  }
  for (const key of Object.keys(breadcrumb)) Reflect.deleteProperty(breadcrumb, key)
  Object.assign(breadcrumb, safe)
  return breadcrumb
}

function safePathSegment(segment: string) {
  if (!segment) return segment
  return staticRouteSegments.has(segment) ? segment : opaqueSegment
}
