import { afterEach, describe, expect, it } from 'bun:test'
import { getAuthRuntime } from '../../auth/runtime/AuthRuntime.js'
import type { ResolvedAuthSession } from '../../auth/runtime/types.js'
import {
  getDefaultMainLoopModelSetting,
  isOpus1mMergeEnabled,
} from './model.js'

const originals = {
  entryPoint: process.env.CLAUDE_CODE_ENTRYPOINT,
  userType: process.env.USER_TYPE,
  buildMode: process.env.NCODE_BUILD_MODE,
  defaultOpus: process.env.NOUMENA_DEFAULT_OPUS_MODEL,
  defaultSonnet: process.env.NOUMENA_DEFAULT_SONNET_MODEL,
  defaultHaiku: process.env.NOUMENA_DEFAULT_HAIKU_MODEL,
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(originals)) {
    const envKey = key === 'entryPoint' ? 'CLAUDE_CODE_ENTRYPOINT' :
      key === 'userType' ? 'USER_TYPE' :
      key === 'buildMode' ? 'NCODE_BUILD_MODE' :
      key === 'defaultOpus' ? 'NOUMENA_DEFAULT_OPUS_MODEL' :
      key === 'defaultSonnet' ? 'NOUMENA_DEFAULT_SONNET_MODEL' :
      'NOUMENA_DEFAULT_HAIKU_MODEL'
    if (value === undefined) {
      delete process.env[envKey]
    } else {
      process.env[envKey] = value
    }
  }
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
  ;
  (
    runtime as {
      getCurrentSession: typeof runtime.getCurrentSession
    }
  ).getCurrentSession = () => session

  try {
    return fn()
  } finally {
    ;
    (
      runtime as {
        getCurrentSession: typeof runtime.getCurrentSession
      }
    ).getCurrentSession = originalGetCurrentSession
  }
}

afterEach(() => {
  restoreEnv()
})

describe('model auth session gating', () => {
  it('defaults noumena-managed first-party sessions to kimi-2.7-coder', () => {
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
    process.env.USER_TYPE = 'test'
    delete process.env.NCODE_BUILD_MODE

    const session = makeSession({
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

    withMockCurrentSession(session, () => {
      expect(getDefaultMainLoopModelSetting()).toBe('kimi-2.7-coder')
    })
  })

  it('does not enable 1M context merging without available metadata', () => {
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
    process.env.USER_TYPE = 'test'
    delete process.env.NCODE_BUILD_MODE

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
      expect(isOpus1mMergeEnabled()).toBe(false)
    })
  })

  it('keeps api-key first-party sessions on the Noumena default model', () => {
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
    process.env.USER_TYPE = 'test'
    delete process.env.NCODE_BUILD_MODE

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
      expect(isOpus1mMergeEnabled()).toBe(false)
      expect(getDefaultMainLoopModelSetting()).toBe('kimi-2.7-coder')
    })
  })
})
