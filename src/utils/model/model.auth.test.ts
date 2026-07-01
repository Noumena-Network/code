import { afterEach, describe, expect, it } from 'bun:test'
import { getAuthRuntime } from '../../auth/runtime/AuthRuntime.js'
import type { ResolvedAuthSession } from '../../auth/runtime/types.js'
import {
  getDefaultFlashModel,
  getDefaultMainLoopModelSetting,
  getDefaultOpusModel,
  isOpus1mMergeEnabled,
} from './model.js'
import { GLM_5_2_MODEL } from './ncodeModels.js'

const originalEntryPoint = process.env.CLAUDE_CODE_ENTRYPOINT
const originalUserType = process.env.USER_TYPE
const originalBuildMode = process.env.NCODE_BUILD_MODE
const originalDisable1m = process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT
const originalUseBedrock = process.env.CLAUDE_CODE_USE_BEDROCK
const originalUseVertex = process.env.CLAUDE_CODE_USE_VERTEX
const originalUseFoundry = process.env.CLAUDE_CODE_USE_FOUNDRY
const originalOpenAIApiKey = process.env.OPENAI_API_KEY
const originalOpenAIModel = process.env.OPENAI_MODEL
const originalDefaultOpus = process.env.NOUMENA_DEFAULT_OPUS_MODEL
const originalDefaultSonnet = process.env.NOUMENA_DEFAULT_SONNET_MODEL
const originalDefaultHaiku = process.env.NOUMENA_DEFAULT_HAIKU_MODEL

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
  if (originalDisable1m === undefined) {
    delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT
  } else {
    process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = originalDisable1m
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
  if (originalDefaultOpus === undefined) {
    delete process.env.NOUMENA_DEFAULT_OPUS_MODEL
  } else {
    process.env.NOUMENA_DEFAULT_OPUS_MODEL = originalDefaultOpus
  }
  if (originalDefaultSonnet === undefined) {
    delete process.env.NOUMENA_DEFAULT_SONNET_MODEL
  } else {
    process.env.NOUMENA_DEFAULT_SONNET_MODEL = originalDefaultSonnet
  }
  if (originalDefaultHaiku === undefined) {
    delete process.env.NOUMENA_DEFAULT_HAIKU_MODEL
  } else {
    process.env.NOUMENA_DEFAULT_HAIKU_MODEL = originalDefaultHaiku
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

describe('model auth session gating', () => {
  it('defaults noumena-managed first-party sessions to the GLM 5.2 premium tier', () => {
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
    process.env.USER_TYPE = 'test'
    delete process.env.NCODE_BUILD_MODE
    delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT
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
      scopes: ['user:inference', 'user:profile'],
      subscription: {
        subscriptionName: 'Noumena Max',
        subscriptionType: 'max',
        rateLimitTier: 'tier-max',
      },
    })

    withMockCurrentSession(session, () => {
      expect(getDefaultMainLoopModelSetting()).toBe(GLM_5_2_MODEL)
    })
  })

  it('fails closed on opus 1M merge for oauth-backed sessions without subscription metadata', () => {
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
    process.env.USER_TYPE = 'test'
    delete process.env.NCODE_BUILD_MODE
    delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT
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
      expect(isOpus1mMergeEnabled()).toBe(false)
    })
  })

  it('keeps api-key first-party sessions on the PAYG model defaults', () => {
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
    process.env.USER_TYPE = 'test'
    delete process.env.NCODE_BUILD_MODE
    delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT
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
      expect(isOpus1mMergeEnabled()).toBe(true)
      expect(getDefaultMainLoopModelSetting()).toBe(GLM_5_2_MODEL)
    })
  })

  it('uses OpenAI-compatible defaults for OPENAI_API_KEY sessions', () => {
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
    process.env.USER_TYPE = 'test'
    delete process.env.NCODE_BUILD_MODE
    delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT
    delete process.env.CLAUDE_CODE_USE_BEDROCK
    delete process.env.CLAUDE_CODE_USE_VERTEX
    delete process.env.CLAUDE_CODE_USE_FOUNDRY
    process.env.OPENAI_API_KEY = 'openai-key'
    process.env.OPENAI_MODEL = 'custom-openai-model'

    const session = makeSession({
      principalKind: 'api_key_user',
      principalSource: 'direct_api_key_env',
      sessionState: 'usable',
      headersKind: 'none',
      providerAuthKind: 'byok_static_env',
      providerPlan: {
        mode: 'byok_static_env',
        source: 'direct_api_key_env',
        staticKeyEnvVarName: 'OPENAI_API_KEY',
      },
      hasUsableApiKey: true,
      apiKey: 'openai-key',
      rawApiKeySource: 'OPENAI_API_KEY',
    })

    withMockCurrentSession(session, () => {
      expect(getDefaultOpusModel()).toBe('custom-openai-model')
      expect(getDefaultFlashModel()).toBe('custom-openai-model')
      expect(getDefaultMainLoopModelSetting()).toBe('custom-openai-model')
    })
  })

})
