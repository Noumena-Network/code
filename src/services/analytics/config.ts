/**
 * Shared analytics configuration
 *
 * Common logic for determining when analytics should be disabled
 * across all analytics systems (Datadog, 1P)
 */

import { isTelemetryDisabled } from '../../utils/privacyLevel.js'

/**
 * Check if analytics operations should be disabled
 *
 * Analytics is disabled in the following cases:
 * - Test environment (NODE_ENV === 'test')
 * - Privacy level is no-telemetry or essential-traffic
 */
export function isAnalyticsDisabled(): boolean {
  return (
    process.env.NODE_ENV === 'test' ||
    isTelemetryDisabled()
  )
}

/**
 * Check if the feedback survey should be suppressed.
 *
 * The survey is a local UI prompt with no transcript data — enterprise
 * customers capture responses via OTEL.
 */
export function isFeedbackSurveyDisabled(): boolean {
  return process.env.NODE_ENV === 'test' || isTelemetryDisabled()
}
