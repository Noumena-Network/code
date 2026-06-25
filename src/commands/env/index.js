import { isInternalBuild } from '../../capabilities/static.js'
import { feature } from 'bun:bundle'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import {
  isPolicyAllowed,
  isPolicyLimitsEligible,
} from '../../services/policyLimits/index.js'
import { getCurrentCommandAvailabilitySession } from '../../utils/commandAvailability.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import {
  hasRemoteEnvCommandSession,
  isCostCommandAuthHiddenForContext,
} from './envCommandSession.js'

const ANT_BUILD_FEATURES = [
  'TRANSCRIPT_CLASSIFIER',
  'KAIROS',
  'KAIROS_BRIEF',
  'BUILTIN_EXPLORE_PLAN_AGENTS',
  'VERIFICATION_AGENT',
  'AGENT_TRIGGERS',
  'AGENT_TRIGGERS_REMOTE',
  'CCR_REMOTE_SETUP',
  'BUDDY',
  'BRIDGE_MODE',
  'HISTORY_SNIP',
  'WORKFLOW_SCRIPTS',
  'KAIROS_GITHUB_WEBHOOKS',
  'TORCH',
  'UDS_INBOX',
  'FORK_SUBAGENT',
  'VOICE_MODE',
  'ULTRAPLAN',
]

const toYesNo = value => (value ? 'yes' : 'no')

function dedupeStrings(values) {
  return Array.from(new Set(values.filter(Boolean)))
}

const AUTH_REASON_PATTERNS = [
  /availability requirement not met: claude-ai/i,
  /requires account/i,
  /OAuth token/i,
  /subscriber auth/i,
  /Run `code auth login`/i,
]

const POLICY_REASON_PATTERNS = [
  /GrowthBook gate/i,
  /\bpolicy\b/i,
  /\beligib/i,
  /organization/i,
  /for this account/i,
  /for this account\/session/i,
]

const CONTEXT_REASON_PATTERNS = [
  /only shown while running in remote mode/i,
  /current terminal already supports/i,
  /sandboxing is unsupported on this platform/i,
  /sandboxing is not enabled for this platform/i,
]

function parseArgs(rawArgs) {
  const flags = new Set(rawArgs.trim().split(/\s+/).filter(Boolean))
  return {
    commands: flags.has('--commands') || flags.has('commands'),
    json: flags.has('--json') || flags.has('json'),
  }
}

function getBuildFeatureStates() {
  return {
    TRANSCRIPT_CLASSIFIER: feature('TRANSCRIPT_CLASSIFIER') ? true : false,
    KAIROS: feature('KAIROS') ? true : false,
    KAIROS_BRIEF: feature('KAIROS_BRIEF') ? true : false,
    BUILTIN_EXPLORE_PLAN_AGENTS: feature('BUILTIN_EXPLORE_PLAN_AGENTS')
      ? true
      : false,
    VERIFICATION_AGENT: feature('VERIFICATION_AGENT') ? true : false,
    AGENT_TRIGGERS: feature('AGENT_TRIGGERS') ? true : false,
    AGENT_TRIGGERS_REMOTE: feature('AGENT_TRIGGERS_REMOTE') ? true : false,
    CCR_REMOTE_SETUP: feature('CCR_REMOTE_SETUP') ? true : false,
    BUDDY: feature('BUDDY') ? true : false,
    BRIDGE_MODE: feature('BRIDGE_MODE') ? true : false,
    HISTORY_SNIP: feature('HISTORY_SNIP') ? true : false,
    WORKFLOW_SCRIPTS: feature('WORKFLOW_SCRIPTS') ? true : false,
    KAIROS_GITHUB_WEBHOOKS: feature('KAIROS_GITHUB_WEBHOOKS') ? true : false,
    TORCH: feature('TORCH') ? true : false,
    UDS_INBOX: feature('UDS_INBOX') ? true : false,
    FORK_SUBAGENT: feature('FORK_SUBAGENT') ? true : false,
    VOICE_MODE: feature('VOICE_MODE') ? true : false,
    ULTRAPLAN: feature('ULTRAPLAN') ? true : false,
  }
}

function visibilityGroupForCommand({
  visibleInUi,
  hidden,
  reasons,
}) {
  if (visibleInUi) return 'visible'
  if (reasons.some(reason => AUTH_REASON_PATTERNS.some(_ => _.test(reason)))) {
    return 'auth-gated'
  }
  if (
    reasons.some(reason => POLICY_REASON_PATTERNS.some(_ => _.test(reason)))
  ) {
    return 'policy-growthbook-or-eligibility-gated'
  }
  if (
    reasons.some(reason => CONTEXT_REASON_PATTERNS.some(_ => _.test(reason)))
  ) {
    return 'context-or-platform-gated'
  }
  if (hidden) {
    return 'hidden-by-design'
  }
  return 'disabled-or-unclassified'
}

function buildBaseRuntimeReport() {
  const buildMode = process.env.NCODE_BUILD_MODE ?? null
  const userType = process.env.USER_TYPE ?? 'external'
  const noumenaMode = buildMode === 'noumena' || buildMode === 'n'
  const internalBuild = noumenaMode || userType === 'ant'
  const isDemo = isEnvTruthy(process.env.IS_DEMO)
  const internalCommandSetEnabled = internalBuild && !isDemo
  const buildFeatures = getBuildFeatureStates()

  const agentsPlatform = {
    available:
      buildFeatures.AGENT_TRIGGERS_REMOTE &&
      getFeatureValue_CACHED_MAY_BE_STALE('ncode_surreal_dali', false) &&
      isPolicyAllowed('allow_remote_sessions'),
    gates: {
      buildFeatureAgentTriggersRemote: buildFeatures.AGENT_TRIGGERS_REMOTE,
      rolloutFlagTenguSurrealDali: getFeatureValue_CACHED_MAY_BE_STALE(
        'ncode_surreal_dali',
        false,
      ),
      policyAllowRemoteSessions: isPolicyAllowed('allow_remote_sessions'),
      policyLimitsEligible: isPolicyLimitsEligible(),
    },
  }

  const verifyPlanExecution = {
    available:
      buildFeatures.VERIFICATION_AGENT &&
      process.env.CLAUDE_CODE_VERIFY_PLAN === 'true',
    gates: {
      buildFeatureVerificationAgent: buildFeatures.VERIFICATION_AGENT,
      defineClaudeCodeVerifyPlan: process.env.CLAUDE_CODE_VERIFY_PLAN ?? null,
    },
  }

  const hiddenReasons = []
  if (!internalBuild) {
    hiddenReasons.push(
      'this bundle was built without Noumena internal compatibility enabled',
    )
  }
  if (isDemo) {
    hiddenReasons.push('IS_DEMO is set, so INTERNAL_ONLY_COMMANDS are excluded')
  }

  return {
    now: new Date().toISOString(),
    buildMode,
    noumenaMode,
    userType,
    isInternalBuild: internalBuild,
    internalCommandSetEnabled,
    buildFeatures,
    commandRuntimeGates: {
      agentsPlatform,
      verifyPlanExecution,
    },
    hiddenReasons,
  }
}

async function getCommandReasons(
  name,
  cmd,
  {
    availableHere,
    enabled,
    hidden,
    hiddenDescriptor,
  },
  modules,
) {
  const reasons = new Set()

  if (!availableHere && cmd.availability?.length) {
    reasons.add(`availability requirement not met: ${cmd.availability.join(', ')}`)
  }

  if (!enabled) {
    reasons.add('isEnabled() returned false')
  }

  if (hidden) {
    if (hiddenDescriptor?.get) {
      reasons.add('hidden by command-specific runtime gate')
    } else if (hiddenDescriptor?.value === true) {
      reasons.add('command sets isHidden=true')
    }
  }

  switch (name) {
    case 'agents-platform':
      if (!feature('AGENT_TRIGGERS_REMOTE')) {
        reasons.add('build feature AGENT_TRIGGERS_REMOTE is off')
      }
      if (!getFeatureValue_CACHED_MAY_BE_STALE('ncode_surreal_dali', false)) {
        reasons.add('GrowthBook gate ncode_surreal_dali is off')
      }
      if (!isPolicyAllowed('allow_remote_sessions')) {
        reasons.add('policy allow_remote_sessions is off')
      }
      break

    case 'remote-control': {
      const reason = await modules.bridgeModule.getBridgeDisabledReason()
      if (reason) reasons.add(reason)
      break
    }

    case 'voice':
      if (!modules.voiceModule.hasVoiceAuth()) {
        reasons.add('requires a Noumena OAuth token for voice mode')
      }
      if (!modules.voiceModule.isVoiceGrowthBookEnabled()) {
        reasons.add('voice GrowthBook kill-switch disables the command')
      }
      break

    case 'web-setup':
      if (!getFeatureValue_CACHED_MAY_BE_STALE('ncode_cobalt_lantern', false)) {
        reasons.add('GrowthBook gate ncode_cobalt_lantern is off')
      }
      if (!isPolicyAllowed('allow_remote_sessions')) {
        reasons.add('policy allow_remote_sessions is off')
      }
      break

    case 'remote-env':
      if (!hasRemoteEnvCommandSession(modules.commandSession)) {
        reasons.add('requires a managed Noumena account with remote-session access')
      }
      if (!isPolicyAllowed('allow_remote_sessions')) {
        reasons.add('policy allow_remote_sessions is off')
      }
      break

    case 'fast':
      if (!modules.fastModeModule.isFastModeEnabled()) {
        reasons.add('fast mode is not enabled for this account/session')
      }
      break

    case 'advisor':
      if (!modules.advisorModule.canUserConfigureAdvisor()) {
        reasons.add('advisor configuration is not enabled for this account')
      }
      break

    case 'passes': {
      const { eligible, hasCache } =
        modules.referralModule.checkCachedPassesEligibility()
      if (!hasCache) {
        reasons.add('passes eligibility cache is missing')
      }
      if (!eligible) {
        reasons.add('account is not currently eligible for passes')
      }
      break
    }

    case 'session':
      if (!modules.stateModule.getIsRemoteMode()) {
        reasons.add('only shown while running in remote mode')
      }
      break

    case 'sandbox':
      if (!modules.sandboxModule.SandboxManager.isSupportedPlatform()) {
        reasons.add('sandboxing is unsupported on this platform')
      } else if (
        !modules.sandboxModule.SandboxManager.isPlatformInEnabledList()
      ) {
        reasons.add('sandboxing is not enabled for this platform')
      }
      break

    case 'terminal-setup':
      if (
        modules.envModule.env.terminal !== null &&
        modules.envModule.env.terminal in modules.nativeCsiuTerminals
      ) {
        reasons.add('current terminal already supports the required key protocol')
      }
      break

    case 'cost':
      if (
        isCostCommandAuthHiddenForContext({
          isInternalBuild: isInternalBuild(),
          session: modules.commandSession,
        })
      ) {
        reasons.add(
          'hidden for managed Noumena-account sessions outside internal compatibility builds',
        )
      }
      break

    default:
      break
  }

  return Array.from(reasons)
}

async function getCommandDiagnosticsReport() {
  const [
    commandsModule,
    fastModeModule,
    advisorModule,
    referralModule,
    bridgeModule,
    voiceModule,
    stateModule,
    sandboxModule,
    envModule,
  ] = await Promise.all([
    import('../../commands.js'),
    import('../../utils/fastMode.js'),
    import('../../utils/advisor.js'),
    import('../../services/api/referral.js'),
    import('../../bridge/bridgeEnabled.js'),
    import('../../voice/voiceModeEnabled.js'),
    import('../../bootstrap/state.js'),
    import('../../utils/sandbox/sandbox-adapter.js'),
    import('../../utils/env.js'),
  ])

  const nativeCsiuTerminals = {
    ghostty: 'Ghostty',
    kitty: 'Kitty',
    'iTerm.app': 'iTerm2',
    WezTerm: 'WezTerm',
  }

  const modules = {
    advisorModule,
    bridgeModule,
    commandSession: getCurrentCommandAvailabilitySession(),
    envModule,
    fastModeModule,
    nativeCsiuTerminals,
    referralModule,
    sandboxModule,
    stateModule,
    voiceModule,
  }

  const groups = new Map()

  for (const cmd of commandsModule.getBuiltInCommandsForDiagnostics()) {
    const name = commandsModule.getCommandName(cmd)
    const availableHere = commandsModule.meetsAvailabilityRequirement(cmd)
    const enabled = commandsModule.isCommandEnabled(cmd)
    const hidden = !!cmd.isHidden
    const hiddenDescriptor = Object.getOwnPropertyDescriptor(cmd, 'isHidden')
    const visibleInUi = availableHere && enabled && !hidden
    const reasons = await getCommandReasons(
      name,
      cmd,
      { availableHere, enabled, hidden, hiddenDescriptor },
      modules,
    )

    const variant = {
      aliases: cmd.aliases ?? [],
      availability: cmd.availability ?? [],
      availableHere,
      enabled,
      hidden,
      reasons,
      supportsNonInteractive:
        cmd.type === 'local' ? cmd.supportsNonInteractive : undefined,
      type: cmd.type,
      visibleInUi,
    }

    const existing = groups.get(name)
    if (existing) {
      existing.aliases = dedupeStrings([...existing.aliases, ...variant.aliases])
      existing.availableHere = existing.availableHere || availableHere
      existing.enabled = existing.enabled || enabled
      existing.hidden = existing.hidden && hidden
      existing.visibleInUi = existing.visibleInUi || visibleInUi
      existing.reasons = dedupeStrings([...existing.reasons, ...reasons])
      existing.visibilityGroup = visibilityGroupForCommand({
        visibleInUi: existing.visibleInUi,
        hidden: existing.hidden,
        reasons: existing.reasons,
      })
      existing.variants.push(variant)
      continue
    }

    groups.set(name, {
      aliases: dedupeStrings(variant.aliases),
      availability: dedupeStrings(variant.availability),
      availableHere,
      compiled: true,
      enabled,
      hidden,
      name,
      reasons,
      variants: [variant],
      visibilityGroup: visibilityGroupForCommand({
        visibleInUi,
        hidden,
        reasons,
      }),
      visibleInUi,
    })
  }

  return Array.from(groups.values()).sort((a, b) => a.name.localeCompare(b.name))
}

async function getRuntimeReport(args) {
  const report = buildBaseRuntimeReport()

  if (!args.commands) {
    return report
  }

  return {
    ...report,
    commandDiagnostics: await getCommandDiagnosticsReport(),
  }
}

function renderTextReport(report) {
  const lines = []
  lines.push('Code Runtime Self-Check')
  lines.push('')
  lines.push(`Baked USER_TYPE: ${report.userType}`)
  lines.push(`Internal bundle (ant): ${toYesNo(report.isInternalBuild)}`)
  lines.push(
    `INTERNAL_ONLY_COMMANDS injected: ${toYesNo(report.internalCommandSetEnabled)}`,
  )
  if (report.hiddenReasons.length > 0) {
    for (const reason of report.hiddenReasons) {
      lines.push(`- Hidden reason: ${reason}`)
    }
  }

  lines.push('')
  lines.push('Ant-relevant build features:')
  for (const featureName of ANT_BUILD_FEATURES) {
    lines.push(
      `- ${featureName}: ${toYesNo(report.buildFeatures[featureName])}`,
    )
  }

  lines.push('')
  lines.push('Runtime gates for internal surfaces:')
  lines.push(
    `- agents-platform available: ${toYesNo(report.commandRuntimeGates.agentsPlatform.available)}`,
  )
  lines.push(
    `  AGENT_TRIGGERS_REMOTE=${toYesNo(
      report.commandRuntimeGates.agentsPlatform.gates
        .buildFeatureAgentTriggersRemote,
    )}, ncode_surreal_dali=${toYesNo(
      report.commandRuntimeGates.agentsPlatform.gates
        .rolloutFlagTenguSurrealDali,
    )}, allow_remote_sessions=${toYesNo(
      report.commandRuntimeGates.agentsPlatform.gates
        .policyAllowRemoteSessions,
    )}`,
  )
  lines.push(
    `- VerifyPlanExecution available: ${toYesNo(report.commandRuntimeGates.verifyPlanExecution.available)}`,
  )
  lines.push(
    `  VERIFICATION_AGENT=${toYesNo(
      report.commandRuntimeGates.verifyPlanExecution.gates
        .buildFeatureVerificationAgent,
    )}, CLAUDE_CODE_VERIFY_PLAN=${
      report.commandRuntimeGates.verifyPlanExecution.gates
        .defineClaudeCodeVerifyPlan ?? '<unset>'
    }`,
  )

  if (report.commandDiagnostics) {
    const visible = report.commandDiagnostics.filter(_ => _.visibleInUi)
    const hidden = report.commandDiagnostics.filter(_ => !_.visibleInUi)
    const grouped = {
      visible: report.commandDiagnostics.filter(
        _ => _.visibilityGroup === 'visible',
      ),
      hiddenByDesign: report.commandDiagnostics.filter(
        _ => _.visibilityGroup === 'hidden-by-design',
      ),
      authGated: report.commandDiagnostics.filter(
        _ => _.visibilityGroup === 'auth-gated',
      ),
      policyGated: report.commandDiagnostics.filter(
        _ => _.visibilityGroup === 'policy-growthbook-or-eligibility-gated',
      ),
      contextGated: report.commandDiagnostics.filter(
        _ => _.visibilityGroup === 'context-or-platform-gated',
      ),
      disabledOther: report.commandDiagnostics.filter(
        _ => _.visibilityGroup === 'disabled-or-unclassified',
      ),
    }

    lines.push('')
    lines.push('Compiled built-in slash commands:')
    lines.push(`- total: ${report.commandDiagnostics.length}`)
    lines.push(`- visible now: ${visible.length}`)
    lines.push(`- hidden or unavailable now: ${hidden.length}`)
    lines.push(
      `- hidden by design: ${grouped.hiddenByDesign.length}`,
    )
    lines.push(`- auth gated: ${grouped.authGated.length}`)
    lines.push(`- policy/growthbook gated: ${grouped.policyGated.length}`)
    lines.push(`- context/platform gated: ${grouped.contextGated.length}`)
    lines.push(`- disabled or unclassified: ${grouped.disabledOther.length}`)

    if (visible.length > 0) {
      lines.push('')
      lines.push('Visible now:')
      lines.push(
        visible
          .map(_ => `/${_.name}`)
          .sort((a, b) => a.localeCompare(b))
          .join(', '),
      )
    }

    if (hidden.length > 0) {
      lines.push('')
      if (grouped.hiddenByDesign.length > 0) {
        lines.push('Hidden by design:')
        lines.push(
          grouped.hiddenByDesign
            .map(_ => `/${_.name}`)
            .sort((a, b) => a.localeCompare(b))
            .join(', '),
        )
      }
      if (grouped.authGated.length > 0) {
        lines.push('')
        lines.push('Auth gated:')
        lines.push(
          grouped.authGated
            .map(_ => `/${_.name}`)
            .sort((a, b) => a.localeCompare(b))
            .join(', '),
        )
      }
      if (grouped.policyGated.length > 0) {
        lines.push('')
        lines.push('Policy / GrowthBook / eligibility gated:')
        lines.push(
          grouped.policyGated
            .map(_ => `/${_.name}`)
            .sort((a, b) => a.localeCompare(b))
            .join(', '),
        )
      }
      if (grouped.contextGated.length > 0) {
        lines.push('')
        lines.push('Context / platform gated:')
        lines.push(
          grouped.contextGated
            .map(_ => `/${_.name}`)
            .sort((a, b) => a.localeCompare(b))
            .join(', '),
        )
      }
      if (grouped.disabledOther.length > 0) {
        lines.push('')
        lines.push('Disabled or unclassified:')
        lines.push(
          grouped.disabledOther
            .map(_ => `/${_.name}`)
            .sort((a, b) => a.localeCompare(b))
            .join(', '),
        )
      }

      lines.push('')
      lines.push('Hidden or unavailable now:')
      for (const command of hidden) {
        const reasons =
          command.reasons.length > 0
            ? command.reasons.join('; ')
            : 'not visible in the current session'
        lines.push(`- /${command.name}: ${reasons}`)
      }
    }
  }

  lines.push('')
  lines.push(
    'Note: USER_TYPE is baked at build time. Setting NCODE_USER_TYPE only at runtime does not switch bundle mode.',
  )
  return lines.join('\n')
}

const call = async args => {
  const parsed = parseArgs(args)
  const report = await getRuntimeReport(parsed)

  return {
    type: 'text',
    value: parsed.json
      ? JSON.stringify(report, null, 2)
      : renderTextReport(report),
  }
}

const env = {
  type: 'local',
  name: 'env',
  description: 'Show runtime build mode and internal gate diagnostics',
  supportsNonInteractive: true,
  isEnabled: () => isInternalBuild(),
  load: () => Promise.resolve({ call }),
}

export default env
