import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { getAuthRuntime } from 'src/auth/runtime/AuthRuntime.js'
import type { ResolvedAuthSession } from 'src/auth/runtime/types.js'
import { resetStateForTests } from 'src/bootstrap/state.js'
import { clearOAuthTokenCache } from 'src/utils/auth.js'
import { getSecureStorage } from 'src/utils/secureStorage/index.js'
import {
  getAssistantMessageFromError,
  INVALID_API_KEY_ERROR_MESSAGE,
  INVALID_API_KEY_ERROR_MESSAGE_EXTERNAL,
  ORG_DISABLED_ERROR_MESSAGE_ENV_KEY,
} from './errors.js'

let tempConfigDir = ''

const envKeys = [
  'NODE_ENV',
  'CI',
  'USER_TYPE',
  'CLAUDE_CODE_ENTRYPOINT',
  'NOUMENA_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_SESSION_ACCESS_TOKEN',
  'CLAUDE_SESSION_INGRESS_TOKEN_FILE',
  'NCODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'CLAUDE_CODE_REMOTE',
  'NCODE_CONFIG_DIR',
  'CLAUDE_CONFIG_DIR',
  'NOUMENA_MODEL',
  'ANTHROPIC_MODEL',
] as const

const originalEnv = Object.fromEntries(
  envKeys.map(key => [key, process.env[key]]),
) as Record<(typeof envKeys)[number], string | undefined>

function restoreEnv() {
  for (const key of envKeys) {
    const value = originalEnv[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

function setStableTestRuntime() {
  restoreEnv()
  process.env.NODE_ENV = 'test'
  process.env.USER_TYPE = 'test'
  process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
  process.env.NCODE_CONFIG_DIR = tempConfigDir
  process.env.CLAUDE_CONFIG_DIR = tempConfigDir
  delete process.env.CI
  delete process.env.NOUMENA_API_KEY
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_AUTH_TOKEN
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  delete process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN
  delete process.env.CLAUDE_SESSION_INGRESS_TOKEN_FILE
  delete process.env.NCODE_OAUTH_TOKEN_FILE_DESCRIPTOR
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR
  delete process.env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR
  delete process.env.CLAUDE_CODE_REMOTE
  delete process.env.NOUMENA_MODEL
  delete process.env.ANTHROPIC_MODEL
}

function makeApiError(status: number, message: string): APIError {
  return new APIError(status, { message }, undefined, new Headers())
}

function getPrimaryErrorText(message: ReturnType<typeof getAssistantMessageFromError>) {
  const content = message.message.content
  if (!Array.isArray(content) || content[0]?.type !== 'text') {
    return null
  }
  return content[0].text
}

function makeManagedErrorSession(): ResolvedAuthSession {
  return {
    principalKind: 'noumena_account',
    principalSource: 'managed_oauth',
    sessionState: 'usable',
    headersKind: 'bearer',
    providerAuthKind: 'noumena_first_party',
    providerPlan: {
      mode: 'noumena_managed',
      source: 'managed_principal',
      staticKeyEnvVarName: null,
    },
    isInteractive: true,
    canRefresh: true,
    canReauthenticateInteractively: true,
    identity: {
      email: 'user@example.com',
      accountUuid: 'acct-123',
      organizationUuid: 'org-123',
      organizationName: 'Acme',
    },
    subscription: {
      subscriptionName: 'Noumena Pro',
      subscriptionType: 'pro',
      rateLimitTier: 'tier-1',
    },
    scopes: ['user:profile', 'user:inference'],
    hasUsableToken: true,
    hasUsableApiKey: false,
    accessToken: 'oauth-token',
    accessTokenExpiresAt: Date.now() + 10 * 60_000,
    refreshTokenPresent: true,
    apiKey: null,
    rawAuthTokenSource: 'noumena.com',
    rawApiKeySource: null,
    recoveryAction: 'none',
    recoveryMessage: null,
    sourceDetails: {
      usedLegacyCompat: false,
      usedEnvVar: false,
      usedFileDescriptor: false,
      usedHelper: false,
    },
  }
}

function makeDirectEnvApiKeySession(params: {
  apiKey: string
  envVarName: 'NOUMENA_API_KEY' | 'ANTHROPIC_API_KEY'
  providerMode: 'noumena_managed' | 'byok_static_env'
}): ResolvedAuthSession {
  return {
    principalKind: 'api_key_user',
    principalSource: 'direct_api_key_env',
    sessionState: 'usable',
    headersKind: 'api_key',
    providerAuthKind:
      params.providerMode === 'noumena_managed'
        ? 'noumena_first_party'
        : 'byok_static_env',
    providerPlan: {
      mode: params.providerMode,
      source: 'direct_api_key_env',
      staticKeyEnvVarName: params.envVarName,
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
    hasUsableApiKey: true,
    accessToken: null,
    accessTokenExpiresAt: null,
    refreshTokenPresent: false,
    apiKey: params.apiKey,
    rawAuthTokenSource: null,
    rawApiKeySource: params.envVarName,
    recoveryAction: 'none',
    recoveryMessage: null,
    sourceDetails: {
      usedLegacyCompat: false,
      usedEnvVar: true,
      usedFileDescriptor: false,
      usedHelper: false,
    },
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

beforeEach(async () => {
  tempConfigDir = await mkdtemp(join(tmpdir(), 'ncode-errors-auth-test-'))
  setStableTestRuntime()
  resetStateForTests()
  clearOAuthTokenCache()
  getSecureStorage().delete()
})

afterEach(async () => {
  restoreEnv()
  resetStateForTests()
  clearOAuthTokenCache()
  getSecureStorage().delete()
  if (tempConfigDir) {
    await rm(tempConfigDir, { recursive: true, force: true })
  }
  tempConfigDir = ''
})

describe('errors canonical auth classification', () => {
  it('blames explicit env API keys for disabled-organization errors', () => {
    process.env.NOUMENA_API_KEY = 'first-party-static-env-key'

    const message = withMockCurrentSession(
      makeDirectEnvApiKeySession({
        apiKey: 'first-party-static-env-key',
        envVarName: 'NOUMENA_API_KEY',
        providerMode: 'noumena_managed',
      }),
      () =>
        getAssistantMessageFromError(
          makeApiError(400, 'Organization has been disabled'),
          'claude-3-7-sonnet-20250219',
        ),
    )

    expect(message.message.content).toEqual([
      expect.objectContaining({
        text: ORG_DISABLED_ERROR_MESSAGE_ENV_KEY,
        type: 'text',
      }),
    ])
  })

  it('classifies explicit env API key failures as external invalid-key errors', () => {
    process.env.ANTHROPIC_API_KEY = 'byok-static-env-key'

    const message = withMockCurrentSession(
      makeDirectEnvApiKeySession({
        apiKey: 'byok-static-env-key',
        envVarName: 'ANTHROPIC_API_KEY',
        providerMode: 'byok_static_env',
      }),
      () =>
        getAssistantMessageFromError(
          new Error('x-api-key rejected'),
          'claude-3-7-sonnet-20250219',
        ),
    )

    expect(message.message.content).toEqual([
      expect.objectContaining({
        text: INVALID_API_KEY_ERROR_MESSAGE_EXTERNAL,
        type: 'text',
      }),
    ])
  })

  it('keeps the default login guidance when there is no external API key session', () => {
    const message = getAssistantMessageFromError(
      new Error('x-api-key rejected'),
      'claude-3-7-sonnet-20250219',
    )

    expect(message.message.content).toEqual([
      expect.objectContaining({
        text: INVALID_API_KEY_ERROR_MESSAGE,
        type: 'text',
      }),
    ])
  })

  it('shows the Opus plan guidance only for canonical managed sessions', () => {
    const message = withMockCurrentSession(
      makeManagedErrorSession(),
      () =>
        getAssistantMessageFromError(
          makeApiError(400, 'invalid model name'),
          'opus',
        ),
    )

    expect(getPrimaryErrorText(message)).toContain(
      'This priority model is not available with the NCode Pro plan.',
    )
  })

  it('does not show the managed Opus plan guidance for static BYOK env-key sessions', () => {
    process.env.ANTHROPIC_API_KEY = 'byok-static-env-key'

    const message = getAssistantMessageFromError(
      makeApiError(400, 'invalid model name'),
      'opus',
    )

    expect(getPrimaryErrorText(message)).not.toContain(
      'This priority model is not available with the NCode Pro plan.',
    )
  })
})
