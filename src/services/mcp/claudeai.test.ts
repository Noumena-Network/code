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
import {
  clearClaudeAIMcpConfigsCache,
  fetchClaudeAIMcpConfigsIfEligible,
} from './claudeai.js'
import { clearOAuthTokenCache, saveOAuthTokensIfNeeded } from '../../utils/auth.js'
import {
  _setGlobalConfigCacheForTesting,
  enableConfigs,
} from '../../utils/config.js'
import { getSecureStorage } from '../../utils/secureStorage/index.js'

let tempConfigDir = ''
const mcpCalls: Array<unknown> = []

const originalAxiosGet = axios.get
const originalMacro = (globalThis as { MACRO?: unknown }).MACRO
const envKeys = [
  'NODE_ENV',
  'CI',
  'NCODE_CONFIG_DIR',
  'CLAUDE_CONFIG_DIR',
  'NOUMENA_PLATFORM_BASE_URL',
  'NOUMENA_ISSUER_BASE_URL',
  'ENABLE_CLAUDEAI_MCP_SERVERS',
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
  'USER_TYPE',
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
  process.env.ENABLE_CLAUDEAI_MCP_SERVERS = '1'
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
  delete process.env.CLAUDE_CODE_ENTRYPOINT
  delete process.env.USER_TYPE

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
    scopes: ['user:profile', 'user:inference', 'user:mcp_servers'],
    subscriptionType: 'max',
    rateLimitTier: 'tier-1',
  })
}

beforeAll(async () => {
  tempConfigDir = await mkdtemp(join(tmpdir(), 'ncode-managed-mcp-test-'))
})

beforeEach(() => {
  restoreEnv()
  setStableTestRuntime()
  enableConfigs()
  clearOAuthTokenCache()
  clearClaudeAIMcpConfigsCache()
  getSecureStorage().delete()
  mcpCalls.length = 0

  axios.get = (async (url: string, options?: unknown) => {
    mcpCalls.push({ url, options })
    return { data: { data: [], has_more: false, next_page: null } }
  }) as typeof axios.get
})

afterEach(() => {
  axios.get = originalAxiosGet
  clearOAuthTokenCache()
  clearClaudeAIMcpConfigsCache()
  getSecureStorage().delete()
  _setGlobalConfigCacheForTesting(null)
  restoreEnv()
  ;(globalThis as { MACRO?: unknown }).MACRO = originalMacro
})

afterAll(async () => {
  await rm(tempConfigDir, { recursive: true, force: true })
})

describe('fetchClaudeAIMcpConfigsIfEligible', () => {
  it('fails closed before network when managed OAuth is expired', async () => {
    writeOauthTokens(Date.now() + 60_000)

    await expect(fetchClaudeAIMcpConfigsIfEligible()).resolves.toEqual({})
    expect(mcpCalls).toEqual([])
  })

  it('uses a usable managed OAuth bearer when the token is fresh', async () => {
    writeOauthTokens(Date.now() + 10 * 60_000)

    await expect(fetchClaudeAIMcpConfigsIfEligible()).resolves.toEqual({})
    expect(mcpCalls).toEqual([
      {
        url: 'https://api.noumena.test/v1/mcp_servers?limit=1000',
        options: {
          headers: {
            Authorization: 'Bearer oauth-token',
            'Content-Type': 'application/json',
            'anthropic-beta': 'mcp-servers-2025-12-04',
            'anthropic-version': '2023-06-01',
          },
          timeout: 5000,
        },
      },
    ])
  })
})
