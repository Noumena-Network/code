import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  _setGlobalConfigCacheForTesting,
  enableConfigs,
} from './config.js'
import { clearOAuthTokenCache, saveOAuthTokensIfNeeded } from './auth.js'
import { getSecureStorage } from './secureStorage/index.js'
import {
  filterAllowedSdkBetas,
  getAllModelBetas,
  shouldUseGlobalCacheScope,
} from './betas.js'
import {
  CONTEXT_1M_BETA_HEADER,
} from '../constants/betas.js'
import { OAUTH_BETA_HEADER } from '../constants/oauth.js'

const envKeys = [
  'NODE_ENV',
  'CI',
  'NCODE_CONFIG_DIR',
  'CLAUDE_CONFIG_DIR',
  'NOUMENA_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'NCODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'CLAUDE_CODE_SESSION_ACCESS_TOKEN',
  'CLAUDE_SESSION_INGRESS_TOKEN_FILE',
  'CLAUDE_CODE_ENTRYPOINT',
  'USER_TYPE',
  'NCODE_BUILD_MODE',
  'DISABLE_INTERLEAVED_THINKING',
  'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
] as const

const originalEnv = Object.fromEntries(
  envKeys.map(key => [key, process.env[key]]),
) as Record<(typeof envKeys)[number], string | undefined>

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
  process.env.NODE_ENV = 'development'
  delete process.env.CI
  process.env.NCODE_CONFIG_DIR = tempConfigDir
  process.env.CLAUDE_CONFIG_DIR = tempConfigDir
  process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
  process.env.USER_TYPE = 'test'
  delete process.env.NCODE_BUILD_MODE
  delete process.env.NOUMENA_API_KEY
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_AUTH_TOKEN
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  delete process.env.NCODE_OAUTH_TOKEN_FILE_DESCRIPTOR
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR
  delete process.env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR
  delete process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN
  delete process.env.CLAUDE_SESSION_INGRESS_TOKEN_FILE
  delete process.env.DISABLE_INTERLEAVED_THINKING
  delete process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS
}

function clearBetaCaches(): void {
  ;(getAllModelBetas as unknown as { cache?: Map<unknown, unknown> }).cache?.clear?.()
}

beforeEach(async () => {
  tempConfigDir = await mkdtemp(join(tmpdir(), 'ncode-betas-'))
  restoreEnv()
  setStableTestRuntime()
  enableConfigs()
  clearOAuthTokenCache()
  getSecureStorage().delete()
  _setGlobalConfigCacheForTesting(null)
  clearBetaCaches()
})

afterEach(async () => {
  clearOAuthTokenCache()
  getSecureStorage().delete()
  _setGlobalConfigCacheForTesting(null)
  clearBetaCaches()
  restoreEnv()
  if (tempConfigDir) {
    await rm(tempConfigDir, { recursive: true, force: true })
  }
  tempConfigDir = ''
})

describe('filterAllowedSdkBetas', () => {
  it('ignores custom sdk betas for canonical managed sessions', () => {
    saveOAuthTokensIfNeeded({
      accessToken: 'managed-access-token',
      refreshToken: 'managed-refresh-token',
      expiresAt: Date.now() + 10 * 60_000,
      scopes: ['user:profile', 'user:inference'],
      subscriptionType: 'max',
      rateLimitTier: 'tier-1',
    })
    clearOAuthTokenCache()

    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = ((message: string) => {
      warnings.push(message)
    }) as typeof console.warn

    try {
      expect(filterAllowedSdkBetas([CONTEXT_1M_BETA_HEADER])).toBeUndefined()
    } finally {
      console.warn = originalWarn
    }

    expect(warnings).toEqual([
      'Warning: Custom betas are only available for API key users. Ignoring provided betas.',
    ])
  })

  it('allows permitted sdk betas for direct API key sessions', () => {
    process.env.NOUMENA_API_KEY = 'noumena-api-key'

    expect(filterAllowedSdkBetas([CONTEXT_1M_BETA_HEADER])).toEqual([
      CONTEXT_1M_BETA_HEADER,
    ])
  })
})

describe('getAllModelBetas', () => {
  it('adds the oauth beta for canonical managed sessions', () => {
    saveOAuthTokensIfNeeded({
      accessToken: 'managed-access-token',
      refreshToken: 'managed-refresh-token',
      expiresAt: Date.now() + 10 * 60_000,
      scopes: ['user:profile', 'user:inference'],
      subscriptionType: 'max',
      rateLimitTier: 'tier-1',
    })
    clearOAuthTokenCache()

    expect(getAllModelBetas('claude-sonnet-4-6')).toContain(OAUTH_BETA_HEADER)
  })

  it('does not add the oauth beta for direct API key sessions', () => {
    process.env.NOUMENA_API_KEY = 'noumena-api-key'

    expect(getAllModelBetas('claude-sonnet-4-6')).not.toContain(
      OAUTH_BETA_HEADER,
    )
  })
})

describe('shouldUseGlobalCacheScope', () => {
  it('enables global prompt-cache scope for managed first-party sessions', () => {
    saveOAuthTokensIfNeeded({
      accessToken: 'managed-access-token',
      refreshToken: 'managed-refresh-token',
      expiresAt: Date.now() + 10 * 60_000,
      scopes: ['user:profile', 'user:inference'],
      subscriptionType: 'max',
      rateLimitTier: 'tier-1',
    })
    clearOAuthTokenCache()

    expect(shouldUseGlobalCacheScope()).toBe(true)
  })

  it('disables global prompt-cache scope for static BYOK direct-provider sessions', () => {
    process.env.ANTHROPIC_API_KEY = 'byok-static-key'

    expect(shouldUseGlobalCacheScope()).toBe(false)
  })
})
