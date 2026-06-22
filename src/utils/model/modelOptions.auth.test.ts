import { afterEach, describe, expect, it } from 'bun:test'
import { getAuthRuntime } from '../../auth/runtime/AuthRuntime.js'
import type { ResolvedAuthSession } from '../../auth/runtime/types.js'
import {
  getDefaultOptionForUser,
  getMaxOpus46_1MOption,
} from './modelOptions.js'
import { parseUserSpecifiedModel } from './model.js'
import {
  DEEPSEEK_V4_FLASH_MODEL,
  GLM_5_2_MODEL,
  KIMI_2_7_CODER_MODEL,
} from './ncodeModels.js'

const originalEntryPoint = process.env.CLAUDE_CODE_ENTRYPOINT
const originalUserType = process.env.USER_TYPE
const originalBuildMode = process.env.NCODE_BUILD_MODE
const originalUseBedrock = process.env.CLAUDE_CODE_USE_BEDROCK
const originalUseVertex = process.env.CLAUDE_CODE_USE_VERTEX
const originalUseFoundry = process.env.CLAUDE_CODE_USE_FOUNDRY

function restoreEnv(): void {
  if (originalEntryPoint === undefined) {
    delete process.env.CLAUDE_CODE_ENTRYPOINT
  } else {
    process.env.CLAUDE_CODE_ENTRYPOINT = originalEntryPoint
  }
  if (originalUserType === undefined) {
    delete process.env.USER_TYPE
  } else {
    process.env.USER_TYPE = originalUserType
  }
  if (originalBuildMode === undefined) {
    delete process.env.NCODE_BUILD_MODE
  } else {
    process.env.NCODE_BUILD_MODE = originalBuildMode
  }
  if (originalUseBedrock === undefined) {
    delete process.env.CLAUDE_CODE_USE_BEDROCK
  } else {
    process.env.CLAUDE_CODE_USE_BEDROCK = originalUseBedrock
  }
  if (originalUseVertex === undefined) {
    delete process.env.CLAUDE_CODE_USE_VERTEX
  } else {
    process.env.CLAUDE_CODE_USE_VERTEX = originalUseVertex
  }
  if (originalUseFoundry === undefined) {
    delete process.env.CLAUDE_CODE_USE_FOUNDRY
  } else {
    process.env.CLAUDE_CODE_USE_FOUNDRY = originalUseFoundry
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
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
    process.env.NCODE_BUILD_MODE = 'noumena'
    delete process.env.USER_TYPE
    delete process.env.CLAUDE_CODE_USE_BEDROCK
    delete process.env.CLAUDE_CODE_USE_VERTEX
    delete process.env.CLAUDE_CODE_USE_FOUNDRY

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
      expect(parseUserSpecifiedModel('k2.7')).toBe(KIMI_2_7_CODER_MODEL)
      expect(parseUserSpecifiedModel('glm-5.2')).toBe(GLM_5_2_MODEL)
      expect(parseUserSpecifiedModel('GLM 5.2')).toBe(GLM_5_2_MODEL)
      expect(parseUserSpecifiedModel('glm-5.2[1m]')).toBe(`${GLM_5_2_MODEL}[1m]`)
      expect(parseUserSpecifiedModel('deepseek-v4-flash')).toBe(
        DEEPSEEK_V4_FLASH_MODEL,
      )
      expect(parseUserSpecifiedModel('dsv4-flash')).toBe(
        DEEPSEEK_V4_FLASH_MODEL,
      )
    })
  })

  it('uses the oauth-backed subscriber description for service bearer sessions', () => {
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
    process.env.USER_TYPE = 'test'
    delete process.env.NCODE_BUILD_MODE
    delete process.env.CLAUDE_CODE_USE_BEDROCK
    delete process.env.CLAUDE_CODE_USE_VERTEX
    delete process.env.CLAUDE_CODE_USE_FOUNDRY

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
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
    process.env.USER_TYPE = 'test'
    delete process.env.NCODE_BUILD_MODE
    delete process.env.CLAUDE_CODE_USE_BEDROCK
    delete process.env.CLAUDE_CODE_USE_VERTEX
    delete process.env.CLAUDE_CODE_USE_FOUNDRY

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

  it('only marks opus 1M as billed-as-extra-usage for oauth-backed first-party sessions', () => {
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
    process.env.USER_TYPE = 'test'
    delete process.env.NCODE_BUILD_MODE
    delete process.env.CLAUDE_CODE_USE_BEDROCK
    delete process.env.CLAUDE_CODE_USE_VERTEX
    delete process.env.CLAUDE_CODE_USE_FOUNDRY

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
