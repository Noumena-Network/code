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

const refreshCalls: string[] = []
let refreshImpl: typeof import('../services/oauth/client.ts').refreshOAuthToken = async () => {
  throw new Error('refresh impl not configured')
}
const performManagedReauthenticationCalls: Array<{
  args: Parameters<
    typeof import('../services/oauth/interactiveReauth.ts').performManagedReauthentication
  >
}> = []
let performManagedReauthenticationImpl: typeof import('../services/oauth/interactiveReauth.ts').performManagedReauthentication =
  async () => {}

const authModule = await import(import.meta.resolve('./auth.ts'))
const configModule = await import(import.meta.resolve('./config.ts'))
const secureStorageModule = await import(
  import.meta.resolve('./secureStorage/index.ts')
)
const bootstrapStateModule = await import(import.meta.resolve('../bootstrap/state.ts'))

const {
  checkAndRefreshOAuthTokenIfNeeded,
  clearOAuthTokenCache,
  saveOAuthTokensIfNeeded,
  _setAuthRuntimeDepsForTesting,
} = authModule
const { enableConfigs, _setGlobalConfigCacheForTesting } = configModule
const { getSecureStorage } = secureStorageModule
const { setIsInteractive } = bootstrapStateModule

let tempConfigDir = ''

const envKeys = [
  'NODE_ENV',
  'CI',
  'NCODE_CONFIG_DIR',
  'CLAUDE_CONFIG_DIR',
  'NOUMENA_PLATFORM_BASE_URL',
  'NOUMENA_ISSUER_BASE_URL',
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
  process.env.NOUMENA_ISSUER_BASE_URL = 'https://api.noumena.test'
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

beforeAll(async () => {
  tempConfigDir = await mkdtemp(join(tmpdir(), 'ncode-auth-refresh-test-'))
})

beforeEach(() => {
  restoreEnv()
  setStableTestRuntime()
  setIsInteractive(true)
  enableConfigs()
  clearOAuthTokenCache()
  getSecureStorage().delete()
  _setGlobalConfigCacheForTesting(null)
  refreshCalls.length = 0
  performManagedReauthenticationCalls.length = 0
  refreshImpl = async () => {
    throw new Error('refresh impl not configured')
  }
  performManagedReauthenticationImpl = async () => {}
  _setAuthRuntimeDepsForTesting({
    refreshOAuthToken: async (...args: Parameters<typeof refreshImpl>) => {
      refreshCalls.push(args[0])
      return refreshImpl(...args)
    },
    performManagedReauthentication: async (
      ...args: Parameters<typeof performManagedReauthenticationImpl>
    ) => {
      performManagedReauthenticationCalls.push({ args })
      return performManagedReauthenticationImpl(...args)
    },
  })
})

afterEach(() => {
  clearOAuthTokenCache()
  getSecureStorage().delete()
  _setGlobalConfigCacheForTesting(null)
  _setAuthRuntimeDepsForTesting(null)
  restoreEnv()
})

afterAll(async () => {
  await rm(tempConfigDir, { recursive: true, force: true })
})

describe('checkAndRefreshOAuthTokenIfNeeded', () => {
  it('reloads shared credentials and retries once with a newer refresh token from disk', async () => {
    saveOAuthTokensIfNeeded({
      accessToken: 'expired-access-token',
      refreshToken: 'refresh-old',
      expiresAt: Date.now() - 60_000,
      scopes: ['user:profile', 'user:inference'],
      subscriptionType: 'max',
      rateLimitTier: 'tier-1',
    })

    refreshImpl = async refreshToken => {
      if (refreshToken === 'refresh-old') {
        const storageData = getSecureStorage().read() || {}
        storageData.claudeAiOauth = {
          ...storageData.claudeAiOauth,
          accessToken: 'expired-access-token',
          refreshToken: 'refresh-new',
          expiresAt: Date.now() - 60_000,
          scopes: ['user:profile', 'user:inference'],
          subscriptionType: 'max',
          rateLimitTier: 'tier-1',
        }
        getSecureStorage().update(storageData)
        throw new Error('refresh_token_invalidated')
      }

      if (refreshToken === 'refresh-new') {
        return {
          accessToken: 'fresh-access-token',
          refreshToken: 'refresh-final',
          expiresAt: Date.now() + 60 * 60_000,
          scopes: ['user:profile', 'user:inference'],
          subscriptionType: 'max',
          rateLimitTier: 'tier-1',
        }
      }

      throw new Error(`unexpected refresh token ${refreshToken}`)
    }

    await expect(checkAndRefreshOAuthTokenIfNeeded()).resolves.toBe(true)
    expect(refreshCalls).toEqual(['refresh-old', 'refresh-new'])

    const storageData = getSecureStorage().read()
    expect(storageData?.claudeAiOauth).toMatchObject({
      accessToken: 'fresh-access-token',
      refreshToken: 'refresh-final',
    })
    expect(storageData?.claudeAiOauth?.expiresAt).toBeGreaterThan(Date.now())
  })

  it('falls back to managed re-auth and resumes automatically on terminal refresh invalidation', async () => {
    saveOAuthTokensIfNeeded({
      accessToken: 'expired-access-token',
      refreshToken: 'refresh-old',
      expiresAt: Date.now() - 60_000,
      scopes: ['user:profile', 'user:inference'],
      subscriptionType: 'max',
      rateLimitTier: 'tier-1',
    })

    refreshImpl = async refreshToken => {
      if (refreshToken === 'refresh-old') {
        throw new Error('invalid_grant')
      }

      throw new Error(`unexpected refresh token ${refreshToken}`)
    }

    performManagedReauthenticationImpl = async () => {
      saveOAuthTokensIfNeeded({
        accessToken: 'reauth-access-token',
        refreshToken: 'reauth-refresh-token',
        expiresAt: Date.now() + 60 * 60_000,
        scopes: ['user:profile', 'user:inference'],
        subscriptionType: 'max',
        rateLimitTier: 'tier-1',
      })
    }

    await expect(checkAndRefreshOAuthTokenIfNeeded()).resolves.toBe(true)
    expect(refreshCalls).toEqual(['refresh-old', 'refresh-old'])
    expect(performManagedReauthenticationCalls).toHaveLength(1)
    expect(performManagedReauthenticationCalls[0]?.args).toEqual([])

    const storageData = getSecureStorage().read()
    expect(storageData?.claudeAiOauth).toMatchObject({
      accessToken: 'reauth-access-token',
      refreshToken: 'reauth-refresh-token',
    })
    expect(storageData?.claudeAiOauth?.expiresAt).toBeGreaterThan(Date.now())
  })

  it('treats axios-style invalid_grant responses as terminal refresh failures and triggers managed re-auth', async () => {
    saveOAuthTokensIfNeeded({
      accessToken: 'expired-access-token',
      refreshToken: 'refresh-old',
      expiresAt: Date.now() - 60_000,
      scopes: ['user:profile', 'user:inference'],
      subscriptionType: 'max',
      rateLimitTier: 'tier-1',
    })

    refreshImpl = async refreshToken => {
      if (refreshToken === 'refresh-old') {
        throw {
          message: 'Request failed with status code 400',
          response: {
            data: {
              error: 'invalid_grant',
            },
          },
        }
      }

      throw new Error(`unexpected refresh token ${refreshToken}`)
    }

    performManagedReauthenticationImpl = async () => {
      saveOAuthTokensIfNeeded({
        accessToken: 'reauth-access-token',
        refreshToken: 'reauth-refresh-token',
        expiresAt: Date.now() + 60 * 60_000,
        scopes: ['user:profile', 'user:inference'],
        subscriptionType: 'max',
        rateLimitTier: 'tier-1',
      })
    }

    await expect(checkAndRefreshOAuthTokenIfNeeded()).resolves.toBe(true)
    expect(refreshCalls).toEqual(['refresh-old', 'refresh-old'])
    expect(performManagedReauthenticationCalls).toHaveLength(1)

    const storageData = getSecureStorage().read()
    expect(storageData?.claudeAiOauth).toMatchObject({
      accessToken: 'reauth-access-token',
      refreshToken: 'reauth-refresh-token',
    })
    expect(storageData?.claudeAiOauth?.expiresAt).toBeGreaterThan(Date.now())
  })

  it('treats nested oauth error-code responses as terminal refresh failures and triggers managed re-auth', async () => {
    saveOAuthTokensIfNeeded({
      accessToken: 'expired-access-token',
      refreshToken: 'refresh-old',
      expiresAt: Date.now() - 60_000,
      scopes: ['user:profile', 'user:inference'],
      subscriptionType: 'max',
      rateLimitTier: 'tier-1',
    })

    refreshImpl = async refreshToken => {
      if (refreshToken === 'refresh-old') {
        throw {
          message: 'Request failed with status code 401',
          response: {
            data: {
              error: {
                code: 'refresh_token_invalidated',
              },
            },
          },
        }
      }

      throw new Error(`unexpected refresh token ${refreshToken}`)
    }

    performManagedReauthenticationImpl = async () => {
      saveOAuthTokensIfNeeded({
        accessToken: 'reauth-access-token',
        refreshToken: 'reauth-refresh-token',
        expiresAt: Date.now() + 60 * 60_000,
        scopes: ['user:profile', 'user:inference'],
        subscriptionType: 'max',
        rateLimitTier: 'tier-1',
      })
    }

    await expect(checkAndRefreshOAuthTokenIfNeeded()).resolves.toBe(true)
    expect(refreshCalls).toEqual(['refresh-old', 'refresh-old'])
    expect(performManagedReauthenticationCalls).toHaveLength(1)

    const storageData = getSecureStorage().read()
    expect(storageData?.claudeAiOauth).toMatchObject({
      accessToken: 'reauth-access-token',
      refreshToken: 'reauth-refresh-token',
    })
    expect(storageData?.claudeAiOauth?.expiresAt).toBeGreaterThan(Date.now())
  })
})
