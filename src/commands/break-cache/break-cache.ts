import { isInternalBuild } from 'src/capabilities/static.js'
import { feature } from 'bun:bundle'
import { randomUUID } from 'crypto'
import {
  getSystemPromptInjection,
  setSystemPromptInjection,
} from '../../context.js'
import { resetPromptCacheBreakDetection } from '../../services/api/promptCacheBreakDetection.js'
import type { LocalCommandCall } from '../../types/command.js'

const HELP_FLAGS = new Set(['help', '--help', '-h'])
const CLEAR_FLAGS = new Set(['clear', 'off', 'disable', 'reset'])
const MAX_MARKER_LEN = 160

function text(value: string): { type: 'text'; value: string } {
  return { type: 'text', value }
}

function isFeatureEnabled(): boolean {
  return feature('BREAK_CACHE_COMMAND') ? true : false
}

function sanitizeValue(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_MARKER_LEN)
}

function formatStatus(): string {
  const current = getSystemPromptInjection()
  const lines = [
    'Prompt cache breaker state',
    `- build feature BREAK_CACHE_COMMAND: ${isFeatureEnabled() ? 'enabled' : 'disabled'}`,
    `- current injection: ${current ? current : '<none>'}`,
    '',
    'Notes:',
    '- This command mutates an ant-only system prompt injection value.',
    '- Changing the value forces a system prompt hash change on the next request.',
    '- If BREAK_CACHE_COMMAND is disabled in the build, the injection is stored but not sent to the API.',
  ]
  return lines.join('\n')
}

function usage(): string {
  return [
    'Usage:',
    '  /break-cache',
    '  /break-cache status',
    '  /break-cache bump [reason]',
    '  /break-cache set <value>',
    '  /break-cache clear',
    '  /break-cache reset-state',
  ].join('\n')
}

function buildBumpValue(reason: string | null): string {
  const sanitized = sanitizeValue(reason ?? '')
  const label = sanitized.length > 0 ? sanitized : 'manual'
  return `${label}|${Date.now()}|${randomUUID().slice(0, 8)}`
}

function setInjectionAndDescribe(
  nextValue: string | null,
  detailLine: string,
): string {
  setSystemPromptInjection(nextValue)
  const featureNote = isFeatureEnabled()
    ? 'BREAK_CACHE_COMMAND is enabled, so this will affect the next API request.'
    : 'BREAK_CACHE_COMMAND is disabled in this build, so this is stored only for diagnostics.'
  const active = getSystemPromptInjection()
  return [detailLine, `Current injection: ${active ?? '<none>'}`, featureNote].join(
    '\n',
  )
}

export const call: LocalCommandCall = async args => {
  if (!isInternalBuild()) {
    return text('`/break-cache` is only available in ANT builds.')
  }

  const trimmed = args.trim()
  if (!trimmed) {
    const bumpValue = buildBumpValue(null)
    return text(
      setInjectionAndDescribe(
        bumpValue,
        `Set cache breaker injection using default bump value.`,
      ),
    )
  }

  const tokens = trimmed.split(/\s+/)
  const subcommand = tokens[0]?.toLowerCase() ?? ''

  if (HELP_FLAGS.has(subcommand)) {
    return text(usage())
  }

  if (subcommand === 'status') {
    return text(formatStatus())
  }

  if (subcommand === 'reset-state') {
    resetPromptCacheBreakDetection()
    return text(
      'Cleared prompt cache break detection tracking state for all tracked sources.',
    )
  }

  if (CLEAR_FLAGS.has(subcommand)) {
    return text(setInjectionAndDescribe(null, 'Cleared cache breaker injection.'))
  }

  if (subcommand === 'set') {
    const rest = tokens.slice(1).join(' ')
    if (!rest) {
      return text(`Missing value for "set".\n\n${usage()}`)
    }
    const sanitized = sanitizeValue(rest)
    if (!sanitized) {
      return text(`Value becomes empty after sanitization.\n\n${usage()}`)
    }
    return text(
      setInjectionAndDescribe(
        sanitized,
        `Set cache breaker injection from explicit value.`,
      ),
    )
  }

  if (subcommand === 'bump') {
    const reason = tokens.slice(1).join(' ')
    const bumpValue = buildBumpValue(reason.length ? reason : null)
    return text(
      setInjectionAndDescribe(
        bumpValue,
        `Set cache breaker injection using bump value.`,
      ),
    )
  }

  const bumpValue = buildBumpValue(trimmed)
  return text(
    setInjectionAndDescribe(
      bumpValue,
      `Interpreted arguments as bump reason and set cache breaker injection.`,
    ),
  )
}
