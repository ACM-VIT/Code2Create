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

type TelemetryEvent = {
  user?: object
  extra?: object
  request?: TelemetryRequest
  breadcrumbs?: TelemetryBreadcrumb[]
  transaction?: string
  logentry?: {
    message?: string
    params?: unknown[]
  }
}

const opaqueSegment = ':id'

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
  delete event.user
  delete event.extra
  if (event.request) {
    const request: TelemetryRequest = {}
    if (event.request.method) request.method = event.request.method.toUpperCase()
    if (event.request.url) request.url = sanitizeTelemetryUrl(event.request.url)
    if (Object.keys(request).length > 0) event.request = request
    else delete event.request
  }
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.flatMap((breadcrumb) => {
      const safe = scrubTelemetryBreadcrumb(breadcrumb)
      return safe ? [safe] : []
    })
  }
  if (event.transaction?.startsWith('/')) {
    event.transaction = sanitizeTelemetryUrl(event.transaction)
  }
  if (event.logentry?.params) delete event.logentry.params
  return event
}

export function scrubTelemetryBreadcrumb<T extends TelemetryBreadcrumb>(breadcrumb: T) {
  if (breadcrumb.category === 'console') return null

  const safe = { ...breadcrumb }
  delete safe.message
  delete safe.data

  if (breadcrumb.data) {
    if (breadcrumb.category === 'fetch' || breadcrumb.category === 'xhr') {
      const data: Record<string, unknown> = {}
      const url = breadcrumb.data.url
      const method = breadcrumb.data.method
      const status = breadcrumb.data.status_code
      if (typeof url === 'string') data.url = sanitizeTelemetryUrl(url)
      if (typeof method === 'string') data.method = method.toUpperCase()
      if (typeof status === 'number' && Number.isFinite(status)) data.status_code = status
      if (Object.keys(data).length > 0) safe.data = data
    } else if (breadcrumb.category === 'navigation') {
      const data: Record<string, unknown> = {}
      const from = breadcrumb.data.from
      const to = breadcrumb.data.to
      if (typeof from === 'string') data.from = sanitizeTelemetryUrl(from)
      if (typeof to === 'string') data.to = sanitizeTelemetryUrl(to)
      if (Object.keys(data).length > 0) safe.data = data
    }
  }
  return safe
}

function safePathSegment(segment: string) {
  if (!segment) return segment
  return /^[a-z][a-z-]{0,31}$/u.test(segment) ? segment : opaqueSegment
}
