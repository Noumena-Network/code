import { isInternalBuild } from 'src/capabilities/static.js'
import { feature } from 'bun:bundle'
import { stat } from 'fs/promises'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { getDumpPromptsPath } from '../../services/api/dumpPrompts.js'
import type { LocalCommandCall } from '../../types/command.js'
import { getDebugLogPath, flushDebugLogs } from '../../utils/debug.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import {
  getStartupPerfLogPath,
  isDetailedProfilingEnabled,
} from '../../utils/startupProfiler.js'
import { isBetaTracingEnabled } from '../../utils/telemetry/betaSessionTracing.js'
import {
  flushPerfettoTraceSnapshot,
  getPerfettoEvents,
  getPerfettoTracePath,
  isPerfettoTracingEnabled,
} from '../../utils/telemetry/perfettoTracing.js'

const HELP_FLAGS = new Set(['help', '--help', '-h'])
const JSON_FLAGS = new Set(['json', '--json'])

type TraceReport = {
  userType: string
  perfetto: {
    buildFeatureEnabled: boolean
    configured: boolean
    enabled: boolean
    tracePath: string | null
    eventCount: number
    periodicWriteIntervalSeconds: number | null
    file: {
      exists: boolean
      sizeBytes: number | null
      modifiedAt: string | null
    }
  }
  betaTracing: {
    configured: boolean
    enabled: boolean
    lanternGate: boolean
    endpointConfigured: boolean
  }
  logs: {
    apiCallsPath: string
    debugLogPath: string
    startupPerfEnabled: boolean
    startupPerfLogPath: string | null
  }
}

function text(value: string): { type: 'text'; value: string } {
  return { type: 'text', value }
}

function parseArgs(rawArgs: string): {
  help: boolean
  json: boolean
  subcommand: string | null
} {
  const tokens = rawArgs.trim().split(/\s+/).filter(Boolean)
  return {
    help: tokens.some(token => HELP_FLAGS.has(token)),
    json: tokens.some(token => JSON_FLAGS.has(token)),
    subcommand: tokens.find(token => !HELP_FLAGS.has(token) && !JSON_FLAGS.has(token)) ?? null,
  }
}

async function getOptionalFileInfo(path: string | null): Promise<{
  exists: boolean
  sizeBytes: number | null
  modifiedAt: string | null
}> {
  if (!path) {
    return { exists: false, sizeBytes: null, modifiedAt: null }
  }

  try {
    const info = await stat(path)
    return {
      exists: true,
      sizeBytes: info.size,
      modifiedAt: new Date(info.mtimeMs).toISOString(),
    }
  } catch {
    return { exists: false, sizeBytes: null, modifiedAt: null }
  }
}

async function buildReport(): Promise<TraceReport> {
  const perfettoBuildFeatureEnabled = feature('PERFETTO_TRACING') ? true : false
  const perfettoTracePath = getPerfettoTracePath()
  const perfettoFile = await getOptionalFileInfo(perfettoTracePath)
  const perfettoIntervalRaw =
    process.env.CLAUDE_CODE_PERFETTO_WRITE_INTERVAL_S ?? ''
  const perfettoInterval =
    perfettoIntervalRaw.length > 0 &&
    Number.isFinite(Number(perfettoIntervalRaw)) &&
    Number(perfettoIntervalRaw) > 0
      ? Number(perfettoIntervalRaw)
      : null

  const betaTracingConfigured =
    isEnvTruthy(process.env.ENABLE_BETA_TRACING_DETAILED) &&
    Boolean(process.env.BETA_TRACING_ENDPOINT)

  return {
    userType: process.env.USER_TYPE ?? 'external',
    perfetto: {
      buildFeatureEnabled: perfettoBuildFeatureEnabled,
      configured:
        perfettoBuildFeatureEnabled &&
        Boolean(process.env.CLAUDE_CODE_PERFETTO_TRACE),
      enabled: isPerfettoTracingEnabled(),
      tracePath: perfettoTracePath,
      eventCount: getPerfettoEvents().length,
      periodicWriteIntervalSeconds: perfettoInterval,
      file: perfettoFile,
    },
    betaTracing: {
      configured: betaTracingConfigured,
      enabled: isBetaTracingEnabled(),
      lanternGate: getFeatureValue_CACHED_MAY_BE_STALE(
        'ncode_trace_lantern',
        false,
      ),
      endpointConfigured: Boolean(process.env.BETA_TRACING_ENDPOINT),
    },
    logs: {
      apiCallsPath: getDumpPromptsPath(),
      debugLogPath: getDebugLogPath(),
      startupPerfEnabled: isDetailedProfilingEnabled(),
      startupPerfLogPath: isDetailedProfilingEnabled()
        ? getStartupPerfLogPath()
        : null,
    },
  }
}

function usage(): string {
  return [
    'Usage:',
    '  /ant-trace',
    '  /ant-trace status',
    '  /ant-trace flush',
    '  /ant-trace --json',
    '',
    'Notes:',
    '- Perfetto tracing only activates when the build includes PERFETTO_TRACING',
    '  and the process starts with CLAUDE_CODE_PERFETTO_TRACE set.',
    '- /ant-trace flush writes the current Perfetto snapshot to disk when tracing',
    '  is already active; it does not enable tracing mid-session.',
  ].join('\n')
}

function toYesNo(value: boolean): string {
  return value ? 'yes' : 'no'
}

function formatReport(report: TraceReport): string {
  const lines = [
    'Ant tracing status',
    '',
    `USER_TYPE: ${report.userType}`,
    '',
    'Perfetto tracing:',
    `- build feature PERFETTO_TRACING: ${toYesNo(report.perfetto.buildFeatureEnabled)}`,
    `- configured by env: ${toYesNo(report.perfetto.configured)}`,
    `- enabled in this process: ${toYesNo(report.perfetto.enabled)}`,
    `- trace path: ${report.perfetto.tracePath ?? '<none>'}`,
    `- in-memory events: ${report.perfetto.eventCount}`,
    `- periodic write interval: ${
      report.perfetto.periodicWriteIntervalSeconds === null
        ? '<disabled>'
        : `${report.perfetto.periodicWriteIntervalSeconds}s`
    }`,
    `- trace file exists: ${toYesNo(report.perfetto.file.exists)}`,
  ]

  if (report.perfetto.file.exists) {
    lines.push(`- trace file size: ${report.perfetto.file.sizeBytes} bytes`)
    lines.push(
      `- trace file modified: ${report.perfetto.file.modifiedAt ?? '<unknown>'}`,
    )
  }

  lines.push('')
  lines.push('Beta tracing:')
  lines.push(
    `- ENABLE_BETA_TRACING_DETAILED + endpoint configured: ${toYesNo(
      report.betaTracing.configured,
    )}`,
  )
  lines.push(`- enabled in this process: ${toYesNo(report.betaTracing.enabled)}`)
  lines.push(
    `- ncode_trace_lantern gate: ${toYesNo(report.betaTracing.lanternGate)}`,
  )

  lines.push('')
  lines.push('Related logs:')
  lines.push(`- API calls: ${report.logs.apiCallsPath}`)
  lines.push(`- Debug log: ${report.logs.debugLogPath}`)
  lines.push(
    `- Startup perf: ${
      report.logs.startupPerfEnabled
        ? report.logs.startupPerfLogPath
        : '<disabled>'
    }`,
  )

  if (!report.perfetto.enabled) {
    lines.push('')
    lines.push(
      'To capture a Perfetto trace, restart NCode with CLAUDE_CODE_PERFETTO_TRACE=1.',
    )
  }

  return lines.join('\n')
}

export const call: LocalCommandCall = async args => {
  if (!isInternalBuild()) {
    return text('`/ant-trace` is only available in ANT builds.')
  }

  const parsed = parseArgs(args)
  if (parsed.help) {
    return text(usage())
  }

  if (parsed.subcommand && !['status', 'flush'].includes(parsed.subcommand)) {
    return text(`Unknown subcommand "${parsed.subcommand}".\n\n${usage()}`)
  }

  if (parsed.subcommand === 'flush') {
    const wroteTrace = await flushPerfettoTraceSnapshot()
    await flushDebugLogs()
    const report = await buildReport()
    const prefix = wroteTrace
      ? 'Flushed current Perfetto trace snapshot to disk.'
      : 'No active Perfetto trace snapshot was available to flush.'
    return text(
      parsed.json
        ? JSON.stringify({ action: 'flush', wroteTrace, report }, null, 2)
        : `${prefix}\n\n${formatReport(report)}`,
    )
  }

  const report = await buildReport()
  return text(parsed.json ? JSON.stringify(report, null, 2) : formatReport(report))
}
