import { scrubTelemetryBreadcrumb, scrubTelemetryEvent } from '@code2create/client-observability/privacy'
import * as Sentry from '@sentry/react-native'

import { reviewerObservabilityConfiguration } from './config'

export function initializeReviewerObservability() {
  if (!reviewerObservabilityConfiguration) return false
  Sentry.init({
    ...reviewerObservabilityConfiguration,
    sendDefaultPii: false,
    attachScreenshot: false,
    attachViewHierarchy: false,
    enableCaptureFailedRequests: false,
    enableAutoPerformanceTracing: false,
    maxBreadcrumbs: 40,
    initialScope: { tags: { surface: 'reviewer-mobile' } },
    beforeSend(event) {
      scrubTelemetryEvent(event)
      return event
    },
    beforeBreadcrumb(breadcrumb) {
      return scrubTelemetryBreadcrumb(breadcrumb)
    },
  })
  return true
}
