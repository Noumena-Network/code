import axios from 'axios'
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { getAuthRuntime } from '../auth/runtime/AuthRuntime.js'
import { OAUTH_BETA_HEADER } from '../constants/oauth.js'
import type { ResolvedAuthSession } from '../auth/runtime/types.js'
import { submitFeedback, type FeedbackData } from './Feedback.js'

const originalAxiosPost = axios.post
const originalMacro = globalThis.MACRO
const originalPlatformBaseUrl = process.env.NOUMENA_PLATFORM_BASE_URL
const originalDisableNonessentialTraffic = process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC

function makeSession(
  overrides: Partial<ResolvedAuthSession> = {},
): ResolvedAuthSession {
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
      email: 'user@noumena.net',
      accountUuid: 'acct-1',
      organizationUuid: 'org-1',
      organizationName: 'Noumena',
    },
    subscription: {
      subscriptionName: 'Noumena Max',
      subscriptionType: 'max',
      rateLimitTier: 'tier-1',
    },
    scopes: ['user:inference'],
    hasUsableToken: true,
    hasUsableApiKey: false,
    accessToken: 'managed-token',
    accessTokenExpiresAt: Date.now() + 60_000,
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
    ...overrides,
  }
}

function makeFeedbackData(): FeedbackData {
  return {
    latestAssistantMessageId: null,
    message_count: 0,
    datetime: '2026-07-01T00:00:00.000Z',
    description: 'export hangs and feedback failed',
    platform: 'linux',
    gitRepo: false,
    version: '0.0.0-test',
    transcript: [],
  }
}

describe('submitFeedback', () => {
  const runtime = getAuthRuntime() as {
    resolveSession: (options?: { allowRefresh?: boolean }) => Promise<ResolvedAuthSession>
    getCurrentSession: () => ResolvedAuthSession
  }
  const originalResolveSession = runtime.resolveSession
  const originalGetCurrentSession = runtime.getCurrentSession

  beforeEach(() => {
    process.env.NOUMENA_PLATFORM_BASE_URL = 'https://api.noumena.test'
    delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
    ;(globalThis as { MACRO?: Record<string, unknown> }).MACRO = {
      VERSION: '0.0.0-test',
    }
    runtime.resolveSession = mock(async () => makeSession())
    runtime.getCurrentSession = mock(() => makeSession())
    axios.post = originalAxiosPost
  })

  afterEach(() => {
    if (originalPlatformBaseUrl === undefined) {
      delete process.env.NOUMENA_PLATFORM_BASE_URL
    } else {
      process.env.NOUMENA_PLATFORM_BASE_URL = originalPlatformBaseUrl
    }
    if (originalDisableNonessentialTraffic === undefined) {
      delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
    } else {
      process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = originalDisableNonessentialTraffic
    }
    ;(globalThis as { MACRO?: unknown }).MACRO = originalMacro
    runtime.resolveSession = originalResolveSession
    runtime.getCurrentSession = originalGetCurrentSession
    axios.post = originalAxiosPost
    mock.restore()
  })

  test('submits to the platform feedback collector with managed auth headers', async () => {
    let capturedRequest:
      | {
          url: string
          body: unknown
          options?: { headers?: Record<string, string> }
        }
      | null = null
    const feedbackData = makeFeedbackData()

    axios.post = (async (url: string, body: unknown, options?: { headers?: Record<string, string> }) => {
      capturedRequest = { url, body, options }
      return { status: 200, data: { feedback_id: 'fb-1' } }
    }) as typeof axios.post

    expect(await submitFeedback(feedbackData)).toEqual({
      success: true,
      feedbackId: 'fb-1',
    })
    expect(capturedRequest?.url).toBe('https://api.noumena.test/api/ncode_feedback')
    expect(capturedRequest?.body).toEqual({ content: JSON.stringify(feedbackData) })
    expect(capturedRequest?.options?.headers).toMatchObject({
      Authorization: 'Bearer managed-token',
      'anthropic-beta': OAUTH_BETA_HEADER,
    })
    expect(runtime.resolveSession).toHaveBeenCalledWith({ allowRefresh: true })
  })

  test('fails closed when the collector route is missing', async () => {
    axios.post = (async () => {
      throw {
        isAxiosError: true,
        response: { status: 404, data: 'not found' },
      }
    }) as typeof axios.post

    expect(await submitFeedback(makeFeedbackData())).toEqual({
      success: false,
    })
  })
})
