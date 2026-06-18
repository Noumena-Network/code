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
import { fetchBootstrapData } from './bootstrap.js'
import { clearOAuthTokenCache, saveOAuthTokensIfNeeded } from '../../utils/auth.js'
import {
  _setGlobalConfigCacheForTesting,
  enableConfigs,
  getGlobalConfig,
  saveGlobalConfig,
} from '../../utils/config.js'
import {
  _resetErrorLogForTesting,
  getInMemoryErrors,
} from '../../utils/log.js'
import { getSecureStorage } from '../../utils/secureStorage/index.js'

let tempConfigDir = ''
let bootstrapPayload: unknown
const bootstrapCalls: Array<unknown> = []

const originalAxiosGet = axios.get
const originalMacro = (globalThis as { MACRO?: unknown }).MACRO
const envKeys = [
  'NODE_ENV',
  'CI',
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
  delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC

  ;(globalThis as { MACRO?: Record<string, unknown> }).MACRO = {
    ...(typeof originalMacro === 'object' && originalMacro !== null
      ? (originalMacro as Record<string, unknown>)
      : {}),
    VERSION: 'test-version',
  }
}

function resetBootstrapConfig(): void {
  saveGlobalConfig(current => ({
    ...current,
    oauthAccount: undefined,
    clientDataCache: null,
    additionalModelOptionsCache: [],
    customApiKeyResponses: {
      approved: [],
      rejected: [],
    },
  }))
}

function writeProfileOauthTokens(expiresAt: number): void {
  saveOAuthTokensIfNeeded({
    accessToken: 'oauth-token',
    refreshToken: 'refresh-token',
    expiresAt,
    scopes: ['user:profile', 'user:inference'],
    subscriptionType: 'max',
    rateLimitTier: 'tier-1',
  })
}

function approveApiKey(apiKey: string): void {
  process.env.ANTHROPIC_API_KEY = apiKey
  saveGlobalConfig(current => ({
    ...current,
    customApiKeyResponses: {
      approved: [apiKey],
      rejected: [],
    },
  }))
}

beforeAll(async () => {
  tempConfigDir = await mkdtemp(join(tmpdir(), 'ncode-bootstrap-test-'))
})

beforeEach(() => {
  restoreEnv()
  setStableTestRuntime()
  enableConfigs()
  clearOAuthTokenCache()
  getSecureStorage().delete()
  _resetErrorLogForTesting()
  resetBootstrapConfig()
  bootstrapCalls.length = 0
  bootstrapPayload = {
    client_data: null,
    additional_model_options: [
      {
        model: 'noumena-model',
        name: 'Noumena Model',
        description: 'test model',
      },
    ],
  }

  axios.get = (async (url: string, options?: unknown) => {
    bootstrapCalls.push({ url, options })
    return { data: bootstrapPayload }
  }) as typeof axios.get
})

afterEach(() => {
  axios.get = originalAxiosGet
  clearOAuthTokenCache()
  getSecureStorage().delete()
  _resetErrorLogForTesting()
  _setGlobalConfigCacheForTesting(null)
  restoreEnv()
  ;(globalThis as { MACRO?: unknown }).MACRO = originalMacro
})

afterAll(async () => {
  await rm(tempConfigDir, { recursive: true, force: true })
})

describe('fetchBootstrapData', () => {
  it('fetches bootstrap through the identity client with oauth auth headers', async () => {
    writeProfileOauthTokens(Date.now() + 10 * 60_000)

    await fetchBootstrapData()

    expect(bootstrapCalls).toEqual([
      {
        url: 'https://api.noumena.test/api/claude_cli/bootstrap',
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
    expect(getInMemoryErrors()).toEqual([])
  })

  it('persists validated non-null client data and transformed model options', async () => {
    writeProfileOauthTokens(Date.now() + 10 * 60_000)
    bootstrapPayload = {
      client_data: {
        rollout: 'enabled',
        nested: { threshold: 3 },
      },
      additional_model_options: [
        {
          model: 'noumena-model',
          name: 'Noumena Model',
          description: 'test model',
        },
      ],
    }

    await fetchBootstrapData()

    expect(getGlobalConfig().clientDataCache).toEqual({
      rollout: 'enabled',
      nested: { threshold: 3 },
    })
    expect(getGlobalConfig().additionalModelOptionsCache).toEqual([
      {
        value: 'noumena-model',
        label: 'Noumena Model',
        description: 'test model',
      },
    ])
    expect(getInMemoryErrors()).toEqual([])
  })

  it('skips persistence when the response fails schema validation', async () => {
    writeProfileOauthTokens(Date.now() + 10 * 60_000)
    bootstrapPayload = {
      client_data: 123,
    }

    await fetchBootstrapData()

    expect(bootstrapCalls).toHaveLength(1)
    expect(getGlobalConfig().clientDataCache).toBeNull()
    expect(getGlobalConfig().additionalModelOptionsCache).toEqual([])
    expect(getInMemoryErrors()).toEqual([])
  })

  it('skips the fetch outside first-party traffic conditions', async () => {

    await fetchBootstrapData()

    expect(bootstrapCalls).toEqual([])
  })

  it('falls back to api-key auth when oauth profile scope is unavailable', async () => {
    approveApiKey('api-key')

    await fetchBootstrapData()

    expect(bootstrapCalls).toEqual([
      {
        url: 'https://api.noumena.test/api/claude_cli/bootstrap',
        options: {
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'ncode/test-version',
            'x-api-key': 'api-key',
          },
          timeout: 5000,
        },
      },
    ])
  })

  it('does not send an expired managed oauth bearer to bootstrap and falls back to api-key auth', async () => {
    writeProfileOauthTokens(Date.now() - 60_000)
    approveApiKey('api-key')

    await fetchBootstrapData()

    expect(bootstrapCalls).toEqual([
      {
        url: 'https://api.noumena.test/api/claude_cli/bootstrap',
        options: {
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'ncode/test-version',
            'x-api-key': 'api-key',
          },
          timeout: 5000,
        },
      },
    ])
  })

  it('skips the fetch when nonessential traffic is disabled', async () => {
    process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'

    await fetchBootstrapData()

    expect(bootstrapCalls).toEqual([])
  })
})
