import axios from 'axios'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  ALL_OAUTH_SCOPES,
  CLAUDE_AI_INFERENCE_SCOPE,
} from '../../constants/oauth.js'
import { isOAuthTokenExpired } from './client.js'
import { getClaudeAIOAuthTokens } from '../../utils/auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import {
  buildAuthUrl,
  exchangeCodeForTokens,
  getOrganizationUUID,
  refreshOAuthToken,
} from './client.js'

const envKeys = [
  'NOUMENA_ISSUER_BASE_URL',
  'NOUMENA_OAUTH_WEB_BASE_URL',
  'NOUMENA_OAUTH_CLIENT_ID',
  'NOUMENA_PLATFORM_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'USER_TYPE',
  'USE_LOCAL_OAUTH',
] as const

const originalEnv = Object.fromEntries(
  envKeys.map(key => [key, process.env[key]]),
) as Record<(typeof envKeys)[number], string | undefined>
const originalAxiosGet = axios.get
const originalAxiosPost = axios.post
const originalOauthAccount = getGlobalConfig().oauthAccount

function resetEnv() {
  for (const key of envKeys) {
    const value = originalEnv[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

beforeEach(() => {
  resetEnv()
  axios.get = originalAxiosGet
  axios.post = originalAxiosPost
  getClaudeAIOAuthTokens.cache?.clear?.()
  saveGlobalConfig(current => ({
    ...current,
    oauthAccount: originalOauthAccount,
  }))
})

afterEach(() => {
  resetEnv()
  axios.get = originalAxiosGet
  axios.post = originalAxiosPost
  getClaudeAIOAuthTokens.cache?.clear?.()
  saveGlobalConfig(current => ({
    ...current,
    oauthAccount: originalOauthAccount,
  }))
})

describe('buildAuthUrl', () => {
  it('uses the Noumena issuer authorize URL and client id for automatic flows', () => {
    delete process.env.NOUMENA_OAUTH_WEB_BASE_URL
    process.env.NOUMENA_ISSUER_BASE_URL = 'https://issuer.noumena.test'
    process.env.NOUMENA_OAUTH_CLIENT_ID = 'noumena-client-id'

    const authUrl = new URL(
      buildAuthUrl({
        codeChallenge: 'challenge',
        state: 'state-1',
        port: 4242,
        isManual: false,
      }),
    )

    expect(authUrl.origin + authUrl.pathname).toBe(
      'https://code.noumena.test/oauth/authorize',
    )
    expect(authUrl.searchParams.get('client_id')).toBe('noumena-client-id')
    expect(authUrl.searchParams.get('redirect_uri')).toBe(
      'http://localhost:4242/callback',
    )
    expect(authUrl.searchParams.get('scope')).toBe(
      ALL_OAUTH_SCOPES.join(' '),
    )
  })

  it('keeps manual redirect semantics and inference-only scope on the Noumena issuer lane', () => {
    process.env.NOUMENA_ISSUER_BASE_URL = 'https://issuer.noumena.test'
    process.env.NOUMENA_OAUTH_WEB_BASE_URL = 'https://console.noumena.test'
    process.env.NOUMENA_OAUTH_CLIENT_ID = 'noumena-client-id'

    const authUrl = new URL(
      buildAuthUrl({
        codeChallenge: 'challenge',
        state: 'state-2',
        port: 4242,
        isManual: true,
        manualRelayId: 'relay-123',
        loginWithClaudeAi: true,
        inferenceOnly: true,
        loginHint: 'dev@noumena.com',
        loginMethod: 'google',
      }),
    )

    expect(authUrl.origin + authUrl.pathname).toBe(
      'https://code.noumena.test/oauth/authorize',
    )
    expect(authUrl.searchParams.get('redirect_uri')).toBe(
      'https://code.noumena.test/oauth/code/callback?app=noumena-code&relay_id=relay-123',
    )
    expect(authUrl.searchParams.get('scope')).toBe(
      CLAUDE_AI_INFERENCE_SCOPE,
    )
    expect(authUrl.searchParams.get('login_hint')).toBe('dev@noumena.com')
    expect(authUrl.searchParams.get('login_method')).toBe('google')
  })
})

describe('exchangeCodeForTokens', () => {
  it('preserves the full manual redirect URI during token exchange', async () => {
    process.env.NOUMENA_ISSUER_BASE_URL = 'https://issuer.noumena.test'
    process.env.NOUMENA_OAUTH_CLIENT_ID = 'noumena-client-id'

    const postCalls: Array<unknown[]> = []
    axios.post = (async (...args: unknown[]) => {
      postCalls.push(args)
      return {
        data: {
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expires_in: 3600,
          scope: ALL_OAUTH_SCOPES.join(' '),
        },
      }
    }) as typeof axios.post

    const manualRedirectUri =
      'https://code.noumena.test/oauth/code/callback?app=noumena-code&relay_id=relay-123'

    await exchangeCodeForTokens(
      'authorization-code',
      'state-3',
      'verifier-3',
      4242,
      true,
      undefined,
      manualRedirectUri,
    )

    expect(postCalls).toHaveLength(1)
    expect(postCalls[0]?.[0]).toBe('https://issuer.noumena.test/oauth/token')
    expect(postCalls[0]?.[1]).toBeInstanceOf(URLSearchParams)
    expect((postCalls[0]?.[1] as URLSearchParams).toString()).toContain(
      'redirect_uri=https%3A%2F%2Fcode.noumena.test%2Foauth%2Fcode%2Fcallback%3Fapp%3Dnoumena-code%26relay_id%3Drelay-123',
    )
  })
})

describe('refreshOAuthToken', () => {
  it('preserves requested scopes when the refresh response omits scope', async () => {
    process.env.NOUMENA_ISSUER_BASE_URL = 'https://issuer.noumena.test'
    process.env.NOUMENA_OAUTH_CLIENT_ID = 'noumena-client-id'
    process.env.NOUMENA_PLATFORM_BASE_URL = 'https://api.noumena.test'

    const postCalls: Array<unknown[]> = []
    axios.post = (async (...args: unknown[]) => {
      postCalls.push(args)
      return {
        data: {
          access_token: 'fresh-access-token',
          refresh_token: 'fresh-refresh-token',
          expires_in: 3600,
        },
      }
    }) as typeof axios.post

    axios.get = (async (url: string) => {
      expect(url).toBe('https://api.noumena.test/api/oauth/profile')
      return {
        data: {
          account: {
            uuid: 'acct-live',
            email: 'live@noumena.test',
            display_name: 'Live User',
            created_at: '2026-04-01T00:00:00Z',
          },
          organization: {
            uuid: 'org-live',
            organization_type: 'claude_pro',
            rate_limit_tier: 'tier_1',
            has_extra_usage_enabled: true,
            billing_type: null,
            subscription_created_at: '2026-04-02T00:00:00Z',
          },
        },
      }
    }) as typeof axios.get

    const tokens = await refreshOAuthToken('refresh-token', {
      scopes: ['user:profile', 'user:inference'],
    })

    expect(tokens.scopes).toEqual(['user:profile', 'user:inference'])
    expect(tokens.subscriptionType).toBe('pro')
    expect(postCalls).toHaveLength(1)
    expect(postCalls[0]?.[0]).toBe('https://issuer.noumena.test/oauth/token')
    expect(postCalls[0]?.[1]).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-token',
      client_id: 'noumena-client-id',
      scope: 'user:profile user:inference',
    })
  })
})

describe('getOrganizationUUID', () => {
  it('revalidates env-token sessions against the profile endpoint and refreshes stale cached org info', async () => {
    process.env.NOUMENA_PLATFORM_BASE_URL = 'https://api.noumena.test'
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-token'

    saveGlobalConfig(current => ({
      ...current,
      oauthAccount: {
        accountUuid: 'acct-stale',
        emailAddress: 'stale@noumena.test',
        organizationUuid: 'org-stale',
      },
    }))

    axios.get = (async (url: string, config?: unknown) => {
      expect(url).toBe('https://api.noumena.test/api/oauth/profile')
      expect(config).toEqual({
        headers: {
          Authorization: 'Bearer oauth-token',
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      })
      return {
        data: {
          account: {
            uuid: 'acct-live',
            email: 'live@noumena.test',
            display_name: 'Live User',
            created_at: '2026-04-01T00:00:00Z',
          },
          organization: {
            uuid: 'org-live',
            has_extra_usage_enabled: true,
            billing_type: null,
            subscription_created_at: '2026-04-02T00:00:00Z',
          },
        },
      }
    }) as typeof axios.get

    await expect(getOrganizationUUID()).resolves.toBe('org-live')
    expect(getGlobalConfig().oauthAccount).toMatchObject({
      accountUuid: 'acct-live',
      emailAddress: 'live@noumena.test',
      organizationUuid: 'org-live',
      displayName: 'Live User',
      hasExtraUsageEnabled: true,
      accountCreatedAt: '2026-04-01T00:00:00Z',
      subscriptionCreatedAt: '2026-04-02T00:00:00Z',
    })
  })

  it('falls back to cached org info when env-token profile lookup fails', async () => {
    process.env.NOUMENA_PLATFORM_BASE_URL = 'https://api.noumena.test'
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-token'

    saveGlobalConfig(current => ({
      ...current,
      oauthAccount: {
        accountUuid: 'acct-stale',
        emailAddress: 'stale@noumena.test',
        organizationUuid: 'org-stale',
      },
    }))

    axios.get = (async () => {
      throw new Error('profile unavailable')
    }) as typeof axios.get

    await expect(getOrganizationUUID()).resolves.toBe('org-stale')
  })
})

describe('isOAuthTokenExpired', () => {
  it('treats null expiresAt as expired', () => {
    expect(isOAuthTokenExpired(null)).toBe(true)
  })

  it('treats NaN expiresAt as expired', () => {
    expect(isOAuthTokenExpired(NaN)).toBe(true)
  })

  it('treats a future expiresAt as not expired', () => {
    const future = Date.now() + 10 * 60_000
    expect(isOAuthTokenExpired(future)).toBe(false)
  })
})
