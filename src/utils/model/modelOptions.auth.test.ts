import { afterEach, describe, expect, it } from 'bun:test'
import { getAuthRuntime } from '../../auth/runtime/AuthRuntime.js'
import type { ResolvedAuthSession } from '../../auth/runtime/types.js'
import {
  getDefaultOptionForUser,
  getModelOptions,
  getMaxOpus46_1MOption,
} from './modelOptions.js'
import { parseUserSpecifiedModel } from './model.js'
import {
  KIMI_2_7_CODER_MODEL,
  KIMI_K2_6_MODEL,
} from './ncodeModels.js'

const envKeys = [
  'CLAUDE_CODE_ENTRYPOINT',
  'USER_TYPE',
  'NCODE_BUILD_MODE',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'NOUMENA_BASE_URL',
  'NOUMENA_MODEL',
  'NOUMENA_SMALL_FAST_MODEL',
  'NOUMENA_DEFAULT_FLASH_MODEL',
  'NOUMENA_DEFAULT_SONNET_MODEL',
  'NOUMENA_DEFAULT_OPUS_MODEL',
  'NOUMENA_DEFAULT_HAIKU_MODEL',
] as const

const originalEnv = Object.fromEntries(
  envKeys.map(key => [key, process.env[key]]),
) as Record<(typeof envKeys)[number], string | undefined>

function restoreEnv(): void {
  for (const key of envKeys) {
    const value = originalEnv[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

function useFirstPartyTestEnv(): void {
  for (const key of envKeys) {
    delete process.env[key]
  }
  process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
  process.env.USER_TYPE = 'test'
}

function makeSession(
  overrides: Partial<ResolvedAuthSession>,
): ResolvedAuthSession {
  return {
    principalKind: 'none',
    principalSource: 'none',
    sessionState: 'unauthenticated',
    headersKind: 'none',
    providerAuthKind: 'none',
    providerPlan: {
      mode: 'none',
      source: 'none',
      staticKeyEnvVarName: null,
    },
    isInteractive: true,
    canRefresh: false,
    canReauthenticateInteractively: false,
    identity: {
      email: null,
      accountUuid: null,
      organizationUuid: null,
      organizationName: null,
    },
    subscription: {
      subscriptionName: null,
      subscriptionType: null,
      rateLimitTier: null,
    },
    scopes: [],
    hasUsableToken: false,
    hasUsableApiKey: false,
    accessToken: null,
    accessTokenExpiresAt: null,
    refreshTokenPresent: false,
    apiKey: null,
    rawAuthTokenSource: null,
    rawApiKeySource: null,
    recoveryAction: 'none',
    recoveryMessage: null,
    sourceDetails: {
      usedLegacyCompat: false,
      usedEnvVar: false,
      usedFileDescriptor: false,
      usedHelper: false,
    },
    ...overrides,
  }
}

function withMockCurrentSession<T>(
  session: ResolvedAuthSession,
  fn: () => T,
): T {
  const runtime = getAuthRuntime()
  const originalGetCurrentSession = runtime.getCurrentSession.bind(runtime)
  ;(
    runtime as {
      getCurrentSession: typeof runtime.getCurrentSession
    }
  ).getCurrentSession = () => session

  try {
    return fn()
  } finally {
    ;(
      runtime as {
        getCurrentSession: typeof runtime.getCurrentSession
      }
    ).getCurrentSession = originalGetCurrentSession
  }
}

afterEach(() => {
  restoreEnv()
})

describe('modelOptions auth gating', () => {
  it('resolves first-class NCode managed model aliases in noumena builds', () => {
    useFirstPartyTestEnv()
    process.env.NCODE_BUILD_MODE = 'noumena'

    const session = makeSession({
      headersKind: 'bearer',
      providerPlan: {
        mode: 'noumena_managed',
        source: 'managed_principal',
        staticKeyEnvVarName: null,
      },
      scopes: ['user:inference'],
    })

    withMockCurrentSession(session, () => {
      expect(parseUserSpecifiedModel('kimi-2.7-coder')).toBe(
        KIMI_2_7_CODER_MODEL,
      )
      expect(parseUserSpecifiedModel('Kimi 2.7 Coder')).toBe(
        KIMI_2_7_CODER_MODEL,
      )
      expect(parseUserSpecifiedModel('k2.6')).toBe(KIMI_K2_6_MODEL)
    })
  })

  it('uses the oauth-backed subscriber description for service bearer sessions', () => {
    useFirstPartyTestEnv()

    const session = makeSession({
      headersKind: 'bearer',
      providerPlan: {
        mode: 'noumena_managed',
        source: 'service_credential',
        staticKeyEnvVarName: null,
      },
      scopes: ['user:inference'],
    })

    withMockCurrentSession(session, () => {
      expect(getDefaultOptionForUser().description).toBe(
        'Use the default model for your plan',
      )
    })
  })

  it('keeps direct API-key sessions on the PAYG default description', () => {
    useFirstPartyTestEnv()

    const session = makeSession({
      principalKind: 'api_key_user',
      principalSource: 'direct_api_key_env',
      sessionState: 'usable',
      headersKind: 'api_key',
      providerAuthKind: 'noumena_first_party',
      providerPlan: {
        mode: 'noumena_managed',
        source: 'direct_api_key_env',
        staticKeyEnvVarName: 'NOUMENA_API_KEY',
      },
      hasUsableApiKey: true,
      apiKey: 'noumena-key',
      rawApiKeySource: 'NOUMENA_API_KEY',
    })

    withMockCurrentSession(session, () => {
      expect(getDefaultOptionForUser().description).toContain(
        'Use the default model',
      )
    })
  })

  it('shows NCode-managed models on the Noumena first-party surface', () => {
    useFirstPartyTestEnv()
    process.env.NOUMENA_BASE_URL = 'https://api.noumena.com'
    process.env.NOUMENA_MODEL = 'Kimi 2.7 Coder'

    const session = makeSession({
      principalKind: 'api_key_user',
      principalSource: 'direct_api_key_env',
      sessionState: 'usable',
      headersKind: 'api_key',
      providerAuthKind: 'noumena_first_party',
      providerPlan: {
        mode: 'noumena_managed',
        source: 'direct_api_key_env',
        staticKeyEnvVarName: 'NOUMENA_API_KEY',
      },
      hasUsableApiKey: true,
      apiKey: 'noumena-key',
      rawApiKeySource: 'NOUMENA_API_KEY',
    })

    withMockCurrentSession(session, () => {
      const options = getModelOptions()
      const labels = options.map(option => option.label)
      expect(labels).toContain('Kimi 2.7 Coder')
      expect(labels.filter(label => label === 'Kimi 2.7 Coder')).toHaveLength(1)
      expect(labels).toContain('Kimi K2.6')
      expect(labels).not.toContain('Balanced')
      expect(labels).not.toContain('Reasoning')
      expect(labels).not.toContain('Fast')
    })
  })

  it('only marks opus 1M as billed-as-extra-usage for oauth-backed first-party sessions', () => {
    useFirstPartyTestEnv()

    const oauthSession = makeSession({
      headersKind: 'bearer',
      providerPlan: {
        mode: 'noumena_managed',
        source: 'managed_principal',
        staticKeyEnvVarName: null,
      },
      scopes: ['user:inference', 'user:profile'],
      subscription: {
        subscriptionName: 'Noumena Max',
        subscriptionType: 'max',
        rateLimitTier: 'tier-max',
      },
    })

    withMockCurrentSession(oauthSession, () => {
      expect(getMaxOpus46_1MOption().description).toContain(
        'Billed as extra usage',
      )
    })

    const apiKeySession = makeSession({
      principalKind: 'api_key_user',
      principalSource: 'direct_api_key_env',
      sessionState: 'usable',
      headersKind: 'api_key',
      providerAuthKind: 'noumena_first_party',
      providerPlan: {
        mode: 'noumena_managed',
        source: 'direct_api_key_env',
        staticKeyEnvVarName: 'NOUMENA_API_KEY',
      },
      hasUsableApiKey: true,
      apiKey: 'noumena-key',
      rawApiKeySource: 'NOUMENA_API_KEY',
    })

    withMockCurrentSession(apiKeySession, () => {
      expect(getMaxOpus46_1MOption().description).not.toContain(
        'Billed as extra usage',
      )
    })
  })
})
