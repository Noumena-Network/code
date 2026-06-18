import axios from 'axios'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { fetchUtilization } from './usage.js'
import { saveOAuthTokensIfNeeded, clearOAuthTokenCache } from '../../utils/auth.js'
import {
  _setGlobalConfigCacheForTesting,
  enableConfigs,
} from '../../utils/config.js'
import { getSecureStorage } from '../../utils/secureStorage/index.js'

let tempConfigDir = ''
let utilizationResponse: unknown = { five_hour: { utilization: 10 } }
const utilizationCalls: Array<unknown> = []

const originalAxiosGet = axios.get
const originalMacro = (globalThis as { MACRO?: unknown }).MACRO
const envKeys = [
  'NODE_ENV',
  'CI',
  'NCODE_CONFIG_DIR',
  'CLAUDE_CONFIG_DIR',
  'NOUMENA_PLATFORM_BASE_URL',
  'NOUMENA_ISSUER_BASE_URL',
  'ANTHROPIC_API_KEY',
  'NOUMENA_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'NCODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'CLAUDE_CODE_SESSION_ACCESS_TOKEN',
  'CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR',
  'CLAUDE_SESSION_INGRESS_TOKEN_FILE',
  'CLAUDE_CODE_ORGANIZATION_UUID',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'CLAUDE_CODE_ENTRYPOINT',
] as const
const originalEnv = Object.fromEntries(
  envKeys.map(key => [key, process.env[key]]),
) as Record<(typeof envKeys)[number], string | undefined>

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
  process.env.NODE_ENV = 'development'
  delete process.env.CI
  process.env.NCODE_CONFIG_DIR = tempConfigDir
  process.env.CLAUDE_CONFIG_DIR = tempConfigDir
  process.env.NOUMENA_PLATFORM_BASE_URL = 'https://api.noumena.test'
  process.env.NOUMENA_ISSUER_BASE_URL = 'https://auth.noumena.test'
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.NOUMENA_API_KEY
  delete process.env.ANTHROPIC_AUTH_TOKEN
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  delete process.env.NCODE_OAUTH_TOKEN_FILE_DESCRIPTOR
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR
  delete process.env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR
  delete process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN
  delete process.env.CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR
  delete process.env.CLAUDE_SESSION_INGRESS_TOKEN_FILE
  delete process.env.CLAUDE_CODE_ORGANIZATION_UUID
  delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC

  ;(globalThis as { MACRO?: Record<string, unknown> }).MACRO = {
    ...(typeof originalMacro === 'object' && originalMacro !== null
      ? (originalMacro as Record<string, unknown>)
      : {}),
    VERSION: 'test-version',
  }
}

function writeOauthTokens(expiresAt: number): void {
  saveOAuthTokensIfNeeded({
    accessToken: 'oauth-token',
    refreshToken: 'refresh-token',
    expiresAt,
    scopes: ['user:profile', 'user:inference'],
    subscriptionType: 'max',
    rateLimitTier: 'tier-1',
  })
}

beforeAll(async () => {
  tempConfigDir = await mkdtemp(join(tmpdir(), 'ncode-usage-test-'))
})

beforeEach(() => {
  restoreEnv()
  setStableTestRuntime()
  enableConfigs()
  clearOAuthTokenCache()
  getSecureStorage().delete()
  utilizationCalls.length = 0
  utilizationResponse = { five_hour: { utilization: 10 } }

  axios.get = (async (url: string, options?: unknown) => {
    utilizationCalls.push({ url, options })
    return { data: utilizationResponse }
  }) as typeof axios.get
})

afterEach(() => {
  axios.get = originalAxiosGet
  clearOAuthTokenCache()
  getSecureStorage().delete()
  _setGlobalConfigCacheForTesting(null)
  restoreEnv()
  ;(globalThis as { MACRO?: unknown }).MACRO = originalMacro
})

afterAll(async () => {
  await rm(tempConfigDir, { recursive: true, force: true })
})

describe('fetchUtilization', () => {
  it('returns an empty object when the subscriber/profile gate is not met', async () => {
    expect(await fetchUtilization()).toEqual({})
    expect(utilizationCalls).toEqual([])
  })

  it('returns null when the oauth token is expired', async () => {
    writeOauthTokens(Date.now() + 60_000)

    expect(await fetchUtilization()).toBeNull()
    expect(utilizationCalls).toEqual([])
  })

  it('delegates to the identity client with merged auth and user-agent headers', async () => {
    writeOauthTokens(Date.now() + 10 * 60_000)

    expect(await fetchUtilization()).toEqual({ five_hour: { utilization: 10 } })
    expect(utilizationCalls).toEqual([
      {
        url: 'https://api.noumena.test/api/oauth/usage',
        options: {
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'ncode/test-version',
            Authorization: 'Bearer oauth-token',
            'anthropic-beta': 'oauth-2025-04-20',
          },
          timeout: 5000,
        },
      },
    ])
  })
})
