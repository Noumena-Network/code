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
import { setIsInteractive } from '../../bootstrap/state.js'
import {
  createMockOauthBrowserHarness,
  createMockOauthServer,
  type MockOauthBrowserHarness,
  type MockOauthServer,
  withMockOauthEnvironment,
} from '../oauth/oauthTestHarness.js'
import { enableConfigs, _setGlobalConfigCacheForTesting } from '../../utils/config.js'
import {
  _setAuthRuntimeDepsForTesting,
  clearOAuthTokenCache,
  saveOAuthTokensIfNeeded,
} from '../../utils/auth.js'
import { getSecureStorage } from '../../utils/secureStorage/index.js'
import { getFirstPartyRequestHeaders } from './client.js'

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
  'NOUMENA_API_KEY',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'NCODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'CLAUDE_CODE_SESSION_ACCESS_TOKEN',
  'CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR',
  'CLAUDE_SESSION_INGRESS_TOKEN_FILE',
  'CLAUDE_CODE_ORGANIZATION_UUID',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_ENTRYPOINT',
  'USER_TYPE',
  'CLAUDE_CODE_REMOTE',
] as const

const originalEnv = Object.fromEntries(
  envKeys.map(key => [key, process.env[key]]),
) as Record<(typeof envKeys)[number], string | undefined>
const originalMacro = (globalThis as { MACRO?: unknown }).MACRO

const liveServers: MockOauthServer[] = []
const liveBrowsers: MockOauthBrowserHarness[] = []
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
  delete process.env.NOUMENA_API_KEY
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  delete process.env.NCODE_OAUTH_TOKEN_FILE_DESCRIPTOR
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR
  delete process.env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR
  delete process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN
  delete process.env.CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR
  delete process.env.CLAUDE_SESSION_INGRESS_TOKEN_FILE
  delete process.env.CLAUDE_CODE_ORGANIZATION_UUID
  delete process.env.ANTHROPIC_AUTH_TOKEN
  delete process.env.CLAUDE_CODE_ENTRYPOINT
  delete process.env.USER_TYPE
  delete process.env.CLAUDE_CODE_REMOTE

  ;(globalThis as { MACRO?: Record<string, unknown> }).MACRO = {
    ...(typeof originalMacro === 'object' && originalMacro !== null
      ? (originalMacro as Record<string, unknown>)
      : {}),
    VERSION: 'test-version',
  }
}

beforeEach(async () => {
  tempConfigDir = await mkdtemp(join(tmpdir(), 'ncode-client-auth-e2e-'))
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
  ;(globalThis as { MACRO?: unknown }).MACRO = originalMacro
})

describe('getFirstPartyRequestHeaders terminal re-auth end-to-end', () => {
  it('repairs expired managed auth and resumes the blocked header request with the new bearer token', async () => {
    const server = await createMockOauthServer()
    liveServers.push(server)
    server.setRefreshGrantError('invalid_grant')

    const browser = await createMockOauthBrowserHarness()
    liveBrowsers.push(browser)

    await withMockOauthEnvironment(server, async () => {
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

      let headers: Record<string, string>
      try {
        headers = await getFirstPartyRequestHeaders()
      } finally {
        process.stdout.write = originalStdoutWrite
      }

      expect(headers!.Authorization).toBe('Bearer access-token')
      expect(headers!['anthropic-beta']).toBe('oauth-2025-04-20')
      expect(headers!['x-app']).toBe('cli')
      expect(headers!['User-Agent']).toContain('ncode/')

      const stdout = stdoutChunks.join('')
      expect(stdout).toContain(
        'Managed session expired. Opening browser to re-authenticate…',
      )
      expect(stdout).toContain('Re-authentication successful. Retrying…')

      const browserInvocations = await browser.readInvocations()
      expect(browserInvocations).toHaveLength(1)
      expect(browserInvocations[0]).toContain('/oauth/authorize')
      expect(browserInvocations[0]).toContain('redirect_uri=http%3A%2F%2Flocalhost%3A')

      expect(server.refreshRequests).toHaveLength(2)
      expect(server.refreshRequests[0]).toMatchObject({
        grant_type: 'refresh_token',
        refresh_token: 'expired-refresh-token',
        client_id: 'noumena-code-test',
      })
      expect(server.refreshRequests[1]).toMatchObject({
        grant_type: 'refresh_token',
        refresh_token: 'expired-refresh-token',
        client_id: 'noumena-code-test',
      })

      expect(server.tokenRequests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            grant_type: 'authorization_code',
            code: 'auth-code-1',
            client_id: 'noumena-code-test',
          }),
        ]),
      )

      const storedTokens = getSecureStorage().read()?.claudeAiOauth
      expect(storedTokens).toMatchObject({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
      })
    })
  })

  it('uses direct API-key auth when managed re-auth cannot recover but a direct key is configured', async () => {
    process.env.NOUMENA_API_KEY = 'fallback-api-key'
    saveOAuthTokensIfNeeded({
      accessToken: 'expired-access-token',
      refreshToken: 'expired-refresh-token',
      expiresAt: Date.now() - 60_000,
      scopes: ['user:profile', 'user:inference'],
      subscriptionType: 'max',
      rateLimitTier: 'tier_1',
    })
    clearOAuthTokenCache()

    _setAuthRuntimeDepsForTesting({
      refreshOAuthToken: async () => {
        throw new Error('invalid_grant')
      },
      performManagedReauthentication: async () => {
        throw new Error('browser launch failed')
      },
    })

    await expect(getFirstPartyRequestHeaders()).resolves.toMatchObject({
      'x-api-key': 'fallback-api-key',
    })
  })
})
