import { isInternalBuild } from 'src/capabilities/static.js'
import type { LocalCommandCall } from '../../types/command.js'
import {
  addExceededLimit,
  clearMockEarlyWarning,
  clearMockHeaders,
  getCurrentMockScenario,
  getMockStatus,
  getScenarioDescription,
  setMockBillingAccess,
  setMockEarlyWarning,
  setMockHeader,
  setMockRateLimitScenario,
  setMockSubscriptionType,
} from '../../services/mockRateLimits.js'

const SCENARIOS = [
  'normal',
  'session-limit-reached',
  'approaching-weekly-limit',
  'weekly-limit-reached',
  'overage-active',
  'overage-warning',
  'overage-exhausted',
  'out-of-credits',
  'org-zero-credit-limit',
  'org-spend-cap-hit',
  'member-zero-credit-limit',
  'seat-tier-zero-credit-limit',
  'opus-limit',
  'opus-warning',
  'sonnet-limit',
  'sonnet-warning',
  'fast-mode-limit',
  'fast-mode-short-limit',
  'extra-usage-required',
  'clear',
] as const

const HEADER_KEYS = [
  'status',
  'reset',
  'claim',
  'overage-status',
  'overage-reset',
  'overage-disabled-reason',
  'fallback',
  'fallback-percentage',
  'retry-after',
  '5h-utilization',
  '5h-reset',
  '5h-surpassed-threshold',
  '7d-utilization',
  '7d-reset',
  '7d-surpassed-threshold',
] as const

const SUBSCRIPTION_TYPES = ['max', 'pro', 'team', 'enterprise'] as const
const EXCEEDED_CLAIMS = [
  'five_hour',
  'seven_day',
  'seven_day_opus',
  'seven_day_sonnet',
] as const
const EARLY_WARNING_CLAIMS = ['5h', '7d', 'overage'] as const
const HELP_ALIASES = new Set(['help', '--help', '-h'])

type ScenarioName = (typeof SCENARIOS)[number]
type HeaderKey = (typeof HEADER_KEYS)[number]
type SubscriptionType = (typeof SUBSCRIPTION_TYPES)[number]
type ExceededClaim = (typeof EXCEEDED_CLAIMS)[number]
type EarlyWarningClaim = (typeof EARLY_WARNING_CLAIMS)[number]

function isScenarioName(value: string): value is ScenarioName {
  return SCENARIOS.includes(value as ScenarioName)
}

function isHeaderKey(value: string): value is HeaderKey {
  return HEADER_KEYS.includes(value as HeaderKey)
}

function isSubscriptionType(value: string): value is SubscriptionType {
  return SUBSCRIPTION_TYPES.includes(value as SubscriptionType)
}

function isExceededClaim(value: string): value is ExceededClaim {
  return EXCEEDED_CLAIMS.includes(value as ExceededClaim)
}

function isEarlyWarningClaim(value: string): value is EarlyWarningClaim {
  return EARLY_WARNING_CLAIMS.includes(value as EarlyWarningClaim)
}

function formatStatusWithCurrentScenario(): string {
  const currentScenario = getCurrentMockScenario()
  const currentLine = currentScenario
    ? `Current scenario: ${currentScenario} (${getScenarioDescription(currentScenario)})`
    : 'Current scenario: custom/manual'
  return `${currentLine}\n\n${getMockStatus()}`
}

function buildScenarioList(): string {
  return SCENARIOS.map(s => `  ${s.padEnd(24)} ${getScenarioDescription(s)}`).join(
    '\n',
  )
}

function parseUtilization(raw: string): number | null {
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null
  }
  if (parsed <= 1) {
    return parsed
  }
  if (parsed <= 100) {
    return parsed / 100
  }
  return null
}

function parseOptionalHours(raw: string | undefined): number | undefined | null {
  if (raw === undefined) {
    return undefined
  }
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null
  }
  return parsed
}

function usageText(): string {
  return [
    'Usage:',
    '  /mock-limits',
    '  /mock-limits status',
    '  /mock-limits scenarios',
    '  /mock-limits scenario <name>',
    '  /mock-limits clear',
    '  /mock-limits header <key> <value|clear>',
    '  /mock-limits exceeded <five_hour|seven_day|seven_day_opus|seven_day_sonnet> <hours>',
    '  /mock-limits early-warning <5h|7d|overage> <utilization(0-1 or 0-100)> [hours]',
    '  /mock-limits clear-early-warning',
    '  /mock-limits subscription <max|pro|team|enterprise|clear>',
    '  /mock-limits billing <admin|non-admin|clear>',
    '',
    'Known headers:',
    `  ${HEADER_KEYS.join(', ')}`,
    '',
    'Known scenarios:',
    buildScenarioList(),
  ].join('\n')
}

function ok(message: string): { type: 'text'; value: string } {
  return { type: 'text', value: message }
}

function errorWithUsage(message: string): { type: 'text'; value: string } {
  return ok(`${message}\n\n${usageText()}`)
}

export const call: LocalCommandCall = async args => {
  if (!isInternalBuild()) {
    return ok('`/mock-limits` is only available in ANT builds.')
  }

  const trimmed = args.trim()
  if (trimmed.length === 0) {
    return ok(formatStatusWithCurrentScenario())
  }

  const parts = trimmed.split(/\s+/)
  const subcommand = parts[0]?.toLowerCase() ?? ''

  if (HELP_ALIASES.has(subcommand)) {
    return ok(usageText())
  }

  if (subcommand === 'status') {
    return ok(formatStatusWithCurrentScenario())
  }

  if (subcommand === 'scenarios') {
    return ok(buildScenarioList())
  }

  if (subcommand === 'clear') {
    clearMockHeaders()
    return ok('Cleared all mock limits, headers, and overrides.\n\n' + getMockStatus())
  }

  if (subcommand === 'scenario') {
    const scenario = parts[1]
    if (!scenario) {
      return errorWithUsage('Missing scenario name.')
    }
    if (!isScenarioName(scenario)) {
      return errorWithUsage(`Unknown scenario "${scenario}".`)
    }
    setMockRateLimitScenario(scenario)
    return ok(
      `Applied scenario: ${scenario} (${getScenarioDescription(scenario)})\n\n${formatStatusWithCurrentScenario()}`,
    )
  }

  if (subcommand === 'header') {
    const key = parts[1]
    const value = parts.slice(2).join(' ')
    if (!key) {
      return errorWithUsage('Missing header key.')
    }
    if (!isHeaderKey(key)) {
      return errorWithUsage(`Unknown header key "${key}".`)
    }
    if (value.length === 0) {
      return errorWithUsage('Missing header value. Use "clear" to remove a header.')
    }
    setMockHeader(key, value === 'clear' ? undefined : value)
    return ok(`Updated header: ${key}=${value}\n\n${formatStatusWithCurrentScenario()}`)
  }

  if (subcommand === 'exceeded') {
    const claim = parts[1]
    const hoursRaw = parts[2]
    if (!claim || !hoursRaw) {
      return errorWithUsage('Usage: /mock-limits exceeded <claim> <hours>')
    }
    if (!isExceededClaim(claim)) {
      return errorWithUsage(`Unknown exceeded-limit claim "${claim}".`)
    }
    const hours = Number(hoursRaw)
    if (!Number.isFinite(hours) || hours < 0) {
      return errorWithUsage(`Invalid hours value "${hoursRaw}".`)
    }
    addExceededLimit(claim, hours)
    return ok(
      `Added exceeded limit: ${claim} (resets in ${hours} hours)\n\n${formatStatusWithCurrentScenario()}`,
    )
  }

  if (subcommand === 'early-warning') {
    const claim = parts[1]
    const utilizationRaw = parts[2]
    const hoursRaw = parts[3]
    if (!claim || !utilizationRaw) {
      return errorWithUsage(
        'Usage: /mock-limits early-warning <5h|7d|overage> <utilization> [hours]',
      )
    }
    if (!isEarlyWarningClaim(claim)) {
      return errorWithUsage(`Unknown early-warning claim "${claim}".`)
    }
    const utilization = parseUtilization(utilizationRaw)
    if (utilization === null) {
      return errorWithUsage(`Invalid utilization "${utilizationRaw}".`)
    }
    const hours = parseOptionalHours(hoursRaw)
    if (hours === null) {
      return errorWithUsage(`Invalid hours value "${hoursRaw}".`)
    }
    setMockEarlyWarning(claim, utilization, hours)
    return ok(
      `Configured early warning: claim=${claim}, utilization=${utilization}, hours=${hours ?? 'default'}\n\n${formatStatusWithCurrentScenario()}`,
    )
  }

  if (subcommand === 'clear-early-warning') {
    clearMockEarlyWarning()
    return ok(`Cleared early warning headers.\n\n${formatStatusWithCurrentScenario()}`)
  }

  if (subcommand === 'subscription') {
    const rawType = parts[1]?.toLowerCase()
    if (!rawType) {
      return errorWithUsage(
        'Usage: /mock-limits subscription <max|pro|team|enterprise|clear>',
      )
    }
    if (rawType === 'clear') {
      setMockSubscriptionType(null)
      return ok(
        'Cleared explicit subscription override.\n\n' + formatStatusWithCurrentScenario(),
      )
    }
    if (!isSubscriptionType(rawType)) {
      return errorWithUsage(`Unknown subscription type "${rawType}".`)
    }
    setMockSubscriptionType(rawType)
    return ok(
      `Set mock subscription override to "${rawType}".\n\n${formatStatusWithCurrentScenario()}`,
    )
  }

  if (subcommand === 'billing') {
    const mode = parts[1]?.toLowerCase()
    if (!mode) {
      return errorWithUsage('Usage: /mock-limits billing <admin|non-admin|clear>')
    }
    if (mode === 'clear') {
      setMockBillingAccess(null)
      return ok(
        'Cleared mock billing access override.\n\n' + formatStatusWithCurrentScenario(),
      )
    }
    if (mode === 'admin' || mode === 'true' || mode === 'yes') {
      setMockBillingAccess(true)
      return ok(
        'Set mock billing access override: true (admin/billing).\n\n' +
          formatStatusWithCurrentScenario(),
      )
    }
    if (mode === 'non-admin' || mode === 'false' || mode === 'no') {
      setMockBillingAccess(false)
      return ok(
        'Set mock billing access override: false (no billing access).\n\n' +
          formatStatusWithCurrentScenario(),
      )
    }
    return errorWithUsage(`Unknown billing mode "${mode}".`)
  }

  return errorWithUsage(`Unknown subcommand "${subcommand}".`)
}
