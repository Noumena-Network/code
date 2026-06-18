import axios from 'axios'
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { setIsInteractive } from '../bootstrap/state.js'
import {
  createMockOauthBrowserHarness,
  createMockOauthServer,
  createMockProtectedResourceServer,
  parseAuthCliOutputEvents,
  type MockOauthBrowserHarness,
  type MockOauthServer,
  type MockProtectedResourceServer,
  waitForPrintedOauthUrl,
  withMockOauthEnvironment,
} from '../services/oauth/oauthTestHarness.js'
import { enableConfigs, _setGlobalConfigCacheForTesting } from './config.js'
import {
  _setAuthRuntimeDepsForTesting,
  clearOAuthTokenCache,
  saveOAuthTokensIfNeeded,
} from './auth.js'
import { getSecureStorage } from './secureStorage/index.js'
import { getAuthHeaders, withOAuth401Retry } from './http.js'

const envKeys = [
  'NODE_ENV',
  'CI',
  'NOUMENA_ISSUER_BASE_URL',
  'NOUMENA_OAUTH_WEB_BASE_URL',
  'NOUMENA_PLATFORM_BASE_URL',
  'NOUMENA_OAUTH_CLIENT_ID',
  'NCODE_CONFIG_DIR',
  'CLAUDE_CONFIG_DIR',
  'BROWSER',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'NCODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'CLAUDE_CODE_SESSION_ACCESS_TOKEN',
  'CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR',
  'CLAUDE_SESSION_INGRESS_TOKEN_FILE',
  'CLAUDE_CODE_ORGANIZATION_UUID',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'NOUMENA_API_KEY',
  'CLAUDE_CODE_ENTRYPOINT',
  'USER_TYPE',
  'CLAUDE_CODE_REMOTE',
] as const

const originalEnv = Object.fromEntries(
  envKeys.map(key => [key, process.env[key]]),
) as Record<(typeof envKeys)[number], string | undefined>

const liveServers: MockOauthServer[] = []
const liveBrowsers: MockOauthBrowserHarness[] = []
const liveProtectedServers: MockProtectedResourceServer[] = []
let tempConfigDir = ''

function restoreEnvVar(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

function restoreEnv(): void {
  for (const key of envKeys) {
    restoreEnvVar(key, originalEnv[key])
  }
}

function setStableTestRuntime(): void {
  process.env.NODE_ENV = 'production'
  delete process.env.CI
  process.env.NCODE_CONFIG_DIR = tempConfigDir
  process.env.CLAUDE_CONFIG_DIR = tempConfigDir
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  delete process.env.NCODE_OAUTH_TOKEN_FILE_DESCRIPTOR
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR
  delete process.env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR
  delete process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN
  delete process.env.CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR
  delete process.env.CLAUDE_SESSION_INGRESS_TOKEN_FILE
  delete process.env.CLAUDE_CODE_ORGANIZATION_UUID
  delete process.env.ANTHROPIC_AUTH_TOKEN
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.NOUMENA_API_KEY
  delete process.env.CLAUDE_CODE_ENTRYPOINT
  delete process.env.USER_TYPE
  delete process.env.CLAUDE_CODE_REMOTE
}

beforeEach(async () => {
  tempConfigDir = await mkdtemp(join(tmpdir(), 'ncode-http-auth-e2e-'))
  restoreEnv()
  setStableTestRuntime()
  setIsInteractive(true)
  enableConfigs()
  clearOAuthTokenCache()
  getSecureStorage().delete()
  _setGlobalConfigCacheForTesting(null)
  _setAuthRuntimeDepsForTesting(null)
})

afterEach(async () => {
  clearOAuthTokenCache()
  getSecureStorage().delete()
  _setGlobalConfigCacheForTesting(null)
  _setAuthRuntimeDepsForTesting(null)
  restoreEnv()
  while (liveProtectedServers.length > 0) {
    await liveProtectedServers.pop()!.close()
  }
  while (liveBrowsers.length > 0) {
    await liveBrowsers.pop()!.close()
  }
  while (liveServers.length > 0) {
    await liveServers.pop()!.close()
  }
  if (tempConfigDir) {
    await rm(tempConfigDir, { recursive: true, force: true })
    tempConfigDir = ''
  }
})

afterAll(() => {
  restoreEnv()
})

async function runProtectedRequest(url: string): Promise<{ ok: true }> {
  return await withOAuth401Retry(async () => {
    const authHeaders = getAuthHeaders()
    if (authHeaders.error) {
      throw new Error(`Failed to get auth headers: ${authHeaders.error}`)
    }
    const response = await axios.get<{ ok: true }>(url, {
      headers: authHeaders.headers,
    })
    return response.data
  }, {
    also403Revoked: true,
  })
}

describe('withOAuth401Retry managed auth end-to-end', () => {
  it('re-authenticates a protected request after a 401 and succeeds on retry', async () => {
    const oauthServer = await createMockOauthServer()
    liveServers.push(oauthServer)
    oauthServer.setRefreshGrantError('invalid_grant')

    const browser = await createMockOauthBrowserHarness()
    liveBrowsers.push(browser)

    const protectedServer = await createMockProtectedResourceServer()
    liveProtectedServers.push(protectedServer)

    await withMockOauthEnvironment(oauthServer, async () => {
      process.env.BROWSER = browser.command
      process.env.NCODE_CONFIG_DIR = tempConfigDir
      process.env.CLAUDE_CONFIG_DIR = tempConfigDir

      saveOAuthTokensIfNeeded({
        accessToken: 'expired-access-token',
        refreshToken: 'expired-refresh-token',
        expiresAt: Date.now() - 60_000,
        scopes: ['user:profile', 'user:inference'],
        subscriptionType: 'max',
        rateLimitTier: 'tier_1',
      })
      clearOAuthTokenCache()

      const stdoutChunks: string[] = []
      const originalStdoutWrite = process.stdout.write.bind(process.stdout)
      process.stdout.write = ((chunk: string | Uint8Array) => {
        stdoutChunks.push(
          typeof chunk === 'string'
            ? chunk
            : Buffer.from(chunk).toString('utf8'),
        )
        return true
      }) as typeof process.stdout.write

      try {
        await expect(runProtectedRequest(protectedServer.baseUrl)).resolves.toEqual({
          ok: true,
        })
      } finally {
        process.stdout.write = originalStdoutWrite
      }

      expect(protectedServer.authorizationHeaders).toEqual([
        'Bearer access-token',
      ])

      const outputEvents = parseAuthCliOutputEvents(stdoutChunks.join(''))
      expect(outputEvents.map(event => event.type)).toContain('reauth_start')
      expect(outputEvents.map(event => event.type)).toContain('reauth_success')
      expect(
        outputEvents.findIndex(event => event.type === 'reauth_start'),
      ).toBeLessThan(
        outputEvents.findIndex(event => event.type === 'reauth_success'),
      )

      const browserInvocations = await browser.readInvocations()
      expect(browserInvocations).toHaveLength(1)
      expect(browserInvocations[0]).toContain('/oauth/authorize')

      expect(oauthServer.tokenRequests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            grant_type: 'authorization_code',
            code: 'auth-code-1',
            client_id: 'noumena-code-test',
          }),
        ]),
      )
    })
  })

  it('re-authenticates a revoked protected request after a 403 and succeeds on retry', async () => {
    const oauthServer = await createMockOauthServer()
    liveServers.push(oauthServer)
    oauthServer.setRefreshGrantError('invalid_grant')

    const browser = await createMockOauthBrowserHarness()
    liveBrowsers.push(browser)

    const protectedServer = await createMockProtectedResourceServer({
      revokedAs403: true,
    })
    liveProtectedServers.push(protectedServer)

    await withMockOauthEnvironment(oauthServer, async () => {
      process.env.BROWSER = browser.command
      process.env.NCODE_CONFIG_DIR = tempConfigDir
      process.env.CLAUDE_CONFIG_DIR = tempConfigDir

      saveOAuthTokensIfNeeded({
        accessToken: 'revoked-access-token',
        refreshToken: 'revoked-refresh-token',
        expiresAt: Date.now() + 10 * 60_000,
        scopes: ['user:profile', 'user:inference'],
        subscriptionType: 'max',
        rateLimitTier: 'tier_1',
      })
      clearOAuthTokenCache()

      await expect(runProtectedRequest(protectedServer.baseUrl)).resolves.toEqual({
        ok: true,
      })

      expect(protectedServer.authorizationHeaders).toEqual([
        'Bearer revoked-access-token',
        'Bearer access-token',
      ])
    })
  })

  it('re-authenticates a protected request through the printed callback-relay URL and succeeds on retry', async () => {
    const oauthServer = await createMockOauthServer()
    liveServers.push(oauthServer)
    oauthServer.setRefreshGrantError('invalid_grant')

    const browser = await createMockOauthBrowserHarness({
      mode: 'record-only',
    })
    liveBrowsers.push(browser)

    const protectedServer = await createMockProtectedResourceServer()
    liveProtectedServers.push(protectedServer)

    await withMockOauthEnvironment(oauthServer, async () => {
      process.env.BROWSER = browser.command
      process.env.NCODE_CONFIG_DIR = tempConfigDir
      process.env.CLAUDE_CONFIG_DIR = tempConfigDir

      saveOAuthTokensIfNeeded({
        accessToken: 'expired-access-token',
        refreshToken: 'expired-refresh-token',
        expiresAt: Date.now() - 60_000,
        scopes: ['user:profile', 'user:inference'],
        subscriptionType: 'max',
        rateLimitTier: 'tier_1',
      })
      clearOAuthTokenCache()

      const stdoutChunks: string[] = []
      const originalStdoutWrite = process.stdout.write.bind(process.stdout)
      process.stdout.write = ((chunk: string | Uint8Array) => {
        stdoutChunks.push(
          typeof chunk === 'string'
            ? chunk
            : Buffer.from(chunk).toString('utf8'),
        )
        return true
      }) as typeof process.stdout.write

      try {
        const requestPromise = runProtectedRequest(protectedServer.baseUrl)
        const manualUrl = await waitForPrintedOauthUrl(() => stdoutChunks.join(''))
        const relay = await oauthServer.completeRelayFlow(manualUrl)

        await expect(requestPromise).resolves.toEqual({
          ok: true,
        })

        expect(relay.relayId).toBeTruthy()
        expect(relay.code).toBe('auth-code-1')
        expect(relay.state).toBeTruthy()
      } finally {
        process.stdout.write = originalStdoutWrite
      }

      expect(protectedServer.authorizationHeaders).toEqual([
        'Bearer access-token',
      ])

      const outputEvents = parseAuthCliOutputEvents(stdoutChunks.join(''))
      expect(outputEvents.map(event => event.type)).toEqual([
        'reauth_start',
        'manual_url',
        'reauth_success',
      ])
      expect(outputEvents[1]).toMatchObject({
        type: 'manual_url',
        url: expect.stringContaining('/oauth/authorize?'),
      })

      const browserInvocations = await browser.readInvocations()
      expect(browserInvocations).toHaveLength(1)
      expect(browserInvocations[0]).toContain('/oauth/authorize')
      expect(browserInvocations[0]).toContain('redirect_uri=http%3A%2F%2Flocalhost%3A')

      expect(oauthServer.relayCompletions).toHaveLength(1)
      expect(oauthServer.tokenRequests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            grant_type: 'authorization_code',
            code: 'auth-code-1',
            client_id: 'noumena-code-test',
          }),
        ]),
      )
    })
  })
})

describe('getAuthHeaders managed auth contract', () => {
  it('returns bearer auth for a usable managed session via the canonical auth runtime', () => {
    saveOAuthTokensIfNeeded({
      accessToken: 'managed-access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 10 * 60_000,
      scopes: ['user:profile', 'user:inference'],
      subscriptionType: 'max',
      rateLimitTier: 'tier_1',
    })
    clearOAuthTokenCache()

    expect(getAuthHeaders()).toEqual({
      headers: {
        Authorization: 'Bearer managed-access-token',
        'anthropic-beta': 'oauth-2025-04-20',
      },
    })
  })

  it('returns bearer auth for an injected service oauth session via the canonical auth runtime', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'service-access-token'

    expect(getAuthHeaders()).toEqual({
      headers: {
        Authorization: 'Bearer service-access-token',
        'anthropic-beta': 'oauth-2025-04-20',
      },
    })
  })

  it('fails closed when the stored managed OAuth token is expired', () => {
    saveOAuthTokensIfNeeded({
      accessToken: 'expired-access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 60_000,
      scopes: ['user:profile', 'user:inference'],
      subscriptionType: 'max',
      rateLimitTier: 'tier_1',
    })
    clearOAuthTokenCache()

    expect(getAuthHeaders()).toEqual({
      headers: {},
      error: 'No usable OAuth token available',
    })
  })

  it('returns API-key headers for direct env API key sessions', () => {
    process.env.NOUMENA_API_KEY = 'noumena-api-key'

    expect(getAuthHeaders()).toEqual({
      headers: {
        'x-api-key': 'noumena-api-key',
      },
    })
  })

  it('does not treat session-ingress-only transport state as principal auth', () => {
    process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN = 'session-ingress-token'

    expect(getAuthHeaders()).toEqual({
      headers: {},
      error: 'No API key available',
    })
  })
})
