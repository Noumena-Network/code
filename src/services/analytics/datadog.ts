import { isInternalBuild } from 'src/capabilities/static.js'
import axios from 'axios'
import { createHash } from 'crypto'
import memoize from 'lodash-es/memoize.js'
import { getOrCreateUserID } from '../../utils/config.js'
import { logError } from '../../utils/log.js'
import { getCanonicalName } from '../../utils/model/model.js'
import { getAPIProvider } from '../../utils/model/providers.js'
import { MODEL_COSTS } from '../../utils/modelCost.js'
import { isAnalyticsDisabled } from './config.js'
import { getEventMetadata } from './metadata.js'

const DEFAULT_FLUSH_INTERVAL_MS = 15000
const MAX_BATCH_SIZE = 100
const NETWORK_TIMEOUT_MS = 5000

const DATADOG_ALLOWED_EVENTS = new Set([
  'chrome_bridge_connection_succeeded',
  'chrome_bridge_connection_failed',
  'chrome_bridge_disconnected',
  'chrome_bridge_tool_call_completed',
  'chrome_bridge_tool_call_error',
  'chrome_bridge_tool_call_started',
  'chrome_bridge_tool_call_timeout',
  'ncode_api_error',
  'ncode_api_success',
  'ncode_brief_mode_enabled',
  'ncode_brief_mode_toggled',
  'ncode_brief_send',
  'ncode_cancel',
  'ncode_compact_failed',
  'ncode_exit',
  'ncode_flicker',
  'ncode_init',
  'ncode_model_fallback_triggered',
  'ncode_oauth_error',
  'ncode_oauth_success',
  'ncode_oauth_token_refresh_failure',
  'ncode_oauth_token_refresh_success',
  'ncode_oauth_token_refresh_lock_acquiring',
  'ncode_oauth_token_refresh_lock_acquired',
  'ncode_oauth_token_refresh_starting',
  'ncode_oauth_token_refresh_completed',
  'ncode_oauth_token_refresh_lock_releasing',
  'ncode_oauth_token_refresh_lock_released',
  'ncode_query_error',
  'ncode_session_file_read',
  'ncode_started',
  'ncode_tool_use_error',
  'ncode_tool_use_granted_in_prompt_permanent',
  'ncode_tool_use_granted_in_prompt_temporary',
  'ncode_tool_use_rejected_in_prompt',
  'ncode_tool_use_success',
  'ncode_uncaught_exception',
  'ncode_unhandled_rejection',
  'ncode_voice_recording_started',
  'ncode_voice_toggled',
  'ncode_team_mem_sync_pull',
  'ncode_team_mem_sync_push',
  'ncode_team_mem_sync_started',
  'ncode_team_mem_entries_capped',
])

const TAG_FIELDS = [
  'arch',
  'clientType',
  'errorType',
  'http_status_range',
  'http_status',
  'kairosActive',
  'model',
  'platform',
  'provider',
  'skillMode',
  'subscriptionType',
  'toolName',
  'userBucket',
  'userType',
  'version',
  'versionBase',
]

function camelToSnakeCase(str: string): string {
  return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)
}

type DatadogLog = {
  ddsource: string
  ddtags: string
  message: string
  service: string
  hostname: string
  [key: string]: unknown
}

type DatadogConfig = {
  endpoint: string
  token: string
}

let logBatch: DatadogLog[] = []
let flushTimer: NodeJS.Timeout | null = null
let datadogInitialized: boolean | null = null

function getDatadogConfig(): DatadogConfig | null {
  const endpoint = process.env.NCODE_DATADOG_LOGS_ENDPOINT?.trim()
  const token = process.env.NCODE_DATADOG_CLIENT_TOKEN?.trim()

  if (!endpoint || !token) {
    return null
  }

  return { endpoint, token }
}

async function flushLogs(): Promise<void> {
  if (logBatch.length === 0) return

  const config = getDatadogConfig()
  if (!config) {
    logBatch = []
    return
  }

  const logsToSend = logBatch
  logBatch = []

  try {
    await axios.post(config.endpoint, logsToSend, {
      headers: {
        'Content-Type': 'application/json',
        'DD-API-KEY': config.token,
      },
      timeout: NETWORK_TIMEOUT_MS,
    })
  } catch (error) {
    logError(error)
  }
}

function scheduleFlush(): void {
  if (flushTimer) return

  flushTimer = setTimeout(() => {
    flushTimer = null
    void flushLogs()
  }, getFlushIntervalMs()).unref()
}

export const initializeDatadog = memoize(async (): Promise<boolean> => {
  if (!getDatadogConfig() || isAnalyticsDisabled()) {
    datadogInitialized = false
    return false
  }

  try {
    datadogInitialized = true
    return true
  } catch (error) {
    logError(error)
    datadogInitialized = false
    return false
  }
})

/**
 * Flush remaining Datadog logs and shut down.
 * Called from gracefulShutdown() before process.exit() since
 * forceExit() prevents the beforeExit handler from firing.
 */
export async function shutdownDatadog(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  await flushLogs()
}

// NOTE: use via src/services/analytics/index.ts > logEvent
export async function trackDatadogEvent(
  eventName: string,
  properties: { [key: string]: boolean | number | undefined },
): Promise<void> {
  if (process.env.NODE_ENV !== 'production') {
    return
  }

  // Don't send events for 3P providers (Bedrock, Vertex, Foundry)
  if (getAPIProvider() !== 'firstParty') {
    return
  }

  // Fast path: use cached result if available to avoid await overhead
  let initialized = datadogInitialized
  if (initialized === null) {
    initialized = await initializeDatadog()
  }
  if (!initialized || !DATADOG_ALLOWED_EVENTS.has(eventName)) {
    return
  }

  try {
    const metadata = await getEventMetadata({
      model: properties.model,
      betas: properties.betas,
    })
    // Destructure to avoid duplicate envContext (once nested, once flattened)
    const { envContext, ...restMetadata } = metadata
    const allData: Record<string, unknown> = {
      ...restMetadata,
      ...envContext,
      ...properties,
      userBucket: getUserBucket(),
    }

    // Normalize MCP tool names to "mcp" for cardinality reduction
    if (
      typeof allData.toolName === 'string' &&
      allData.toolName.startsWith('mcp__')
    ) {
      allData.toolName = 'mcp'
    }

    // Normalize model names for cardinality reduction (external users only)
    if (!isInternalBuild() && typeof allData.model === 'string') {
      const shortName = getCanonicalName(allData.model.replace(/\[1m]$/i, ''))
      allData.model = shortName in MODEL_COSTS ? shortName : 'other'
    }

    // Truncate dev version to base + date (remove timestamp and sha for cardinality reduction)
    // e.g. "2.0.53-dev.20251124.t173302.sha526cc6a" -> "2.0.53-dev.20251124"
    if (typeof allData.version === 'string') {
      allData.version = allData.version.replace(
        /^(\d+\.\d+\.\d+-dev\.\d{8})\.t\d+\.sha[a-f0-9]+$/,
        '$1',
      )
    }

    // Transform status to http_status and http_status_range to avoid Datadog reserved field
    if (allData.status !== undefined && allData.status !== null) {
      const statusCode = String(allData.status)
      allData.http_status = statusCode

      // Determine status range (1xx, 2xx, 3xx, 4xx, 5xx)
      const firstDigit = statusCode.charAt(0)
      if (firstDigit >= '1' && firstDigit <= '5') {
        allData.http_status_range = `${firstDigit}xx`
      }

      // Remove original status field to avoid conflict with Datadog's reserved field
      delete allData.status
    }

    // Build ddtags with high-cardinality fields for filtering.
    // event:<name> is prepended so the event name is searchable via the
    // log search API; the `message` field is a reserved field and is not
    // queryable from dashboard widget queries or the aggregation API.
    const allDataRecord = allData
    const tags = [
      `event:${eventName}`,
      ...TAG_FIELDS.filter(
        field =>
          allDataRecord[field] !== undefined && allDataRecord[field] !== null,
      ).map(field => `${camelToSnakeCase(field)}:${allDataRecord[field]}`),
    ]

    const log: DatadogLog = {
      ddsource: 'nodejs',
      ddtags: tags.join(','),
      message: eventName,
      service: 'ncode',
      hostname: 'ncode',
      env: process.env.USER_TYPE,
    }

    // Add all fields as searchable attributes (not duplicated in tags)
    for (const [key, value] of Object.entries(allData)) {
      if (value !== undefined && value !== null) {
        log[camelToSnakeCase(key)] = value
      }
    }

    logBatch.push(log)

    // Flush immediately if batch is full, otherwise schedule
    if (logBatch.length >= MAX_BATCH_SIZE) {
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      void flushLogs()
    } else {
      scheduleFlush()
    }
  } catch (error) {
    logError(error)
  }
}

const NUM_USER_BUCKETS = 30

/**
 * Gets a 'bucket' that the user ID falls into.
 *
 * For alerting purposes, we want to alert on the number of users impacted
 * by an issue, rather than the number of events- often a small number of users
 * can generate a large number of events (e.g. due to retries). To approximate
 * this without ruining cardinality by counting user IDs directly, we hash the user ID
 * and assign it to one of a fixed number of buckets.
 *
 * This allows us to estimate the number of unique users by counting unique buckets,
 * while preserving user privacy and reducing cardinality.
 */
const getUserBucket = memoize((): number => {
  const userId = getOrCreateUserID()
  const hash = createHash('sha256').update(userId).digest('hex')
  return parseInt(hash.slice(0, 8), 16) % NUM_USER_BUCKETS
})

function getFlushIntervalMs(): number {
  // Allow tests to override to not block on the default flush interval.
  return (
    parseInt(process.env.NCODE_DATADOG_FLUSH_INTERVAL_MS || '', 10) ||
    DEFAULT_FLUSH_INTERVAL_MS
  )
}

export function resetDatadogForTests(): void {
  logBatch = []
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  datadogInitialized = null
  initializeDatadog.cache.clear?.()
}
