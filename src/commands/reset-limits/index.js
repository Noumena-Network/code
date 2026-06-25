import { isInternalBuild } from '../../capabilities/static.js'
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import {
  clearMockHeaders,
  getCurrentMockScenario,
  getMockStatus,
  getScenarioDescription,
  shouldProcessMockLimits,
} from '../../services/mockRateLimits.js'

const VERBOSE_FLAGS = new Set(['--verbose', '-v'])

const call = async args => {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  const verbose = tokens.some(token => VERBOSE_FLAGS.has(token))

  const beforeScenario = getCurrentMockScenario()
  const beforeStatus = getMockStatus()
  const hadHeaderlessOverride = Boolean(process.env.CLAUDE_MOCK_HEADERLESS_429)

  clearMockHeaders()

  // This env var only affects the current process. Clearing it here makes
  // /reset-limits fully reset in-session rate-limit mock behavior.
  if (hadHeaderlessOverride) {
    delete process.env.CLAUDE_MOCK_HEADERLESS_429
  }

  const afterStatus = getMockStatus()
  const stillMocking = shouldProcessMockLimits()

  const lines = ['Reset mock rate-limit state.']

  if (beforeScenario) {
    lines.push(
      `Previous scenario: ${beforeScenario} (${getScenarioDescription(beforeScenario)})`,
    )
  }

  if (hadHeaderlessOverride) {
    lines.push('Cleared CLAUDE_MOCK_HEADERLESS_429 for this process.')
  }

  lines.push(afterStatus)

  if (verbose) {
    lines.push('')
    lines.push('Previous state:')
    lines.push(beforeStatus)
  }

  if (stillMocking) {
    lines.push('')
    lines.push(
      'Warning: rate-limit mocking still appears active. Check process env and mock settings.',
    )
  }

  return {
    type: 'text',
    value: lines.join('\n'),
  }
}

export const resetLimits = {
  type: 'local',
  name: 'reset-limits',
  description: 'Clear mocked rate-limit state and return to real limits',
  argumentHint: '[--verbose]',
  isEnabled: () =>
    isInternalBuild() && !getIsNonInteractiveSession(),
  isHidden: true,
  supportsNonInteractive: false,
  load: () => Promise.resolve({ call }),
}

export const resetLimitsNonInteractive = {
  type: 'local',
  name: 'reset-limits',
  description: 'Clear mocked rate-limit state and return to real limits',
  argumentHint: '[--verbose]',
  isEnabled: () =>
    isInternalBuild() && getIsNonInteractiveSession(),
  isHidden: true,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
}

export default resetLimits
